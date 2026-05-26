import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SkillsRegistry } from "../skills/skills-registry.service";
import { interpolateTemplate } from "../dialog/dialog-template.utils";
import type { ScriptSpec, SlotSpec } from "../bot-configuration/v2/bot-config-v2.types";
import {
  SCRIPT_STATE_CONFIRM,
  SCRIPT_STATE_SLOT_PREFIX,
  ScriptSlots,
  ScriptStepInput,
  ScriptStepOutcome,
} from "./script.types";

@Injectable()
export class ScriptRunnerService {
  private readonly logger = new Logger(ScriptRunnerService.name);

  // ВАЖНО: \b в JS работает только для ASCII «слов» — для кириллицы используем явный
  // suffix: пробел/пунктуация/конец строки.
  private static readonly CANCEL_RE =
    /^\s*(отмена|отмени(ть|те)?|стоп|не\s+надо|передума(л|ла)|cancel|stop)(?:[\s,.!?]|$)/iu;
  private static readonly YES_RE =
    /^\s*(да|ок(ей)?|верно|согласен|согласна|подтверждаю|подтвердить|конечно|yes|y|\+)(?:[\s,.!?]|$)/iu;
  private static readonly NO_RE =
    /^\s*(нет|неа|не\s+верно|неправильно|no|n|-)(?:[\s,.!?]|$)/iu;

  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: SkillsRegistry,
  ) {}

  async step(input: ScriptStepInput): Promise<ScriptStepOutcome> {
    const { conversation, bot, userText } = input;
    const scripts = bot.scripts ?? {};
    if (Object.keys(scripts).length === 0 && !conversation.activeScript) {
      return { handled: false };
    }

    if (conversation.activeScript) {
      const def = scripts[conversation.activeScript];
      if (!def) {
        // Скрипт был, но его убрали из конфига — сбрасываем состояние и выходим.
        this.logger.warn(
          `Active script "${conversation.activeScript}" not in current config — clearing state.`,
        );
        await this.clearState(conversation.id);
        return { handled: false };
      }
      return this.continueActive(conversation, bot.id, conversation.activeScript, def, userText);
    }

    const triggered = this.findTriggeredScript(userText, scripts);
    if (!triggered) {
      return { handled: false };
    }
    return this.activate(conversation, triggered.name, triggered.def);
  }

  private async activate(
    conversation: ScriptStepInput["conversation"],
    name: string,
    def: ScriptSpec,
  ): Promise<ScriptStepOutcome> {
    const firstSlot = def.order[0];
    if (!firstSlot || !def.slots[firstSlot]) {
      this.logger.warn(`Script "${name}" has empty order or missing first slot — ignoring trigger.`);
      return { handled: false };
    }
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        activeScript: name,
        activeScriptState: SCRIPT_STATE_SLOT_PREFIX + firstSlot,
        activeScriptSlots: {} as unknown as Prisma.InputJsonValue,
      },
    });
    return {
      handled: true,
      reply: def.slots[firstSlot].ask,
      terminal: false,
      scriptName: name,
    };
  }

  private async continueActive(
    conversation: ScriptStepInput["conversation"],
    botId: string,
    name: string,
    def: ScriptSpec,
    userText: string,
  ): Promise<ScriptStepOutcome> {
    if (ScriptRunnerService.CANCEL_RE.test(userText)) {
      await this.clearState(conversation.id);
      return { handled: true, reply: def.onCancel, terminal: true, scriptName: name };
    }

    const slots = this.readSlots(conversation.activeScriptSlots);
    const state = conversation.activeScriptState ?? "";

    if (state === SCRIPT_STATE_CONFIRM) {
      return this.handleConfirm(conversation, botId, name, def, slots, userText);
    }

    if (state.startsWith(SCRIPT_STATE_SLOT_PREFIX)) {
      const slotName = state.slice(SCRIPT_STATE_SLOT_PREFIX.length);
      const spec = def.slots[slotName];
      if (!spec) {
        this.logger.warn(`Script "${name}" missing slot "${slotName}" — clearing state.`);
        await this.clearState(conversation.id);
        return { handled: false };
      }
      return this.handleSlot(conversation, name, def, slots, slotName, spec, userText);
    }

    // Неизвестное состояние — лечим сбросом.
    this.logger.warn(`Script "${name}" in unknown state "${state}" — clearing.`);
    await this.clearState(conversation.id);
    return { handled: false };
  }

  private async handleSlot(
    conversation: ScriptStepInput["conversation"],
    name: string,
    def: ScriptSpec,
    slots: ScriptSlots,
    slotName: string,
    spec: SlotSpec,
    userText: string,
  ): Promise<ScriptStepOutcome> {
    const value = userText.trim();
    if (!value) {
      return {
        handled: true,
        reply: spec.ask,
        terminal: false,
        scriptName: name,
      };
    }
    if (spec.validate) {
      let re: RegExp | undefined;
      try {
        re = new RegExp(spec.validate, "iu");
      } catch (e) {
        this.logger.warn(
          `Script "${name}" slot "${slotName}" invalid regex "${spec.validate}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (re && !re.test(value)) {
        return {
          handled: true,
          reply: spec.validateErrorReply ?? `Не понял — повторите, пожалуйста. ${spec.ask}`,
          terminal: false,
          scriptName: name,
        };
      }
    }

    const updatedSlots = { ...slots, [slotName]: value };
    const idx = def.order.indexOf(slotName);
    const nextSlotName = idx >= 0 && idx + 1 < def.order.length ? def.order[idx + 1] : undefined;

    if (nextSlotName) {
      const nextSpec = def.slots[nextSlotName];
      if (!nextSpec) {
        this.logger.warn(`Script "${name}" missing next slot "${nextSlotName}".`);
        await this.clearState(conversation.id);
        return { handled: false };
      }
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          activeScriptState: SCRIPT_STATE_SLOT_PREFIX + nextSlotName,
          activeScriptSlots: updatedSlots as unknown as Prisma.InputJsonValue,
        },
      });
      return {
        handled: true,
        reply: nextSpec.ask,
        terminal: false,
        scriptName: name,
      };
    }

    // Все слоты собраны — переход в confirm.
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        activeScriptState: SCRIPT_STATE_CONFIRM,
        activeScriptSlots: updatedSlots as unknown as Prisma.InputJsonValue,
      },
    });
    return {
      handled: true,
      reply: interpolateTemplate(def.confirm, updatedSlots),
      terminal: false,
      scriptName: name,
    };
  }

  private async handleConfirm(
    conversation: ScriptStepInput["conversation"],
    botId: string,
    name: string,
    def: ScriptSpec,
    slots: ScriptSlots,
    userText: string,
  ): Promise<ScriptStepOutcome> {
    if (ScriptRunnerService.YES_RE.test(userText)) {
      const skill = this.skills.get(def.onConfirm.skill);
      if (!skill) {
        this.logger.warn(
          `Script "${name}" onConfirm.skill="${def.onConfirm.skill}" not found.`,
        );
        await this.clearState(conversation.id);
        return {
          handled: true,
          reply: def.onConfirm.errorReply,
          terminal: true,
          scriptName: name,
        };
      }
      let success = false;
      try {
        const result = await skill.execute(slots, {
          botId,
          conversationId: conversation.id,
        });
        // Convention: skill returns {ok:true} or {ok:false,error:...}.
        const data = result.data as { ok?: boolean } | undefined;
        success = data?.ok !== false;
      } catch (e) {
        this.logger.warn(
          `Script "${name}" onConfirm.skill="${def.onConfirm.skill}" threw: ${e instanceof Error ? e.message : String(e)}`,
        );
        success = false;
      }
      await this.clearState(conversation.id);
      return {
        handled: true,
        reply: interpolateTemplate(success ? def.onConfirm.successReply : def.onConfirm.errorReply, slots),
        terminal: true,
        scriptName: name,
      };
    }
    if (ScriptRunnerService.NO_RE.test(userText)) {
      await this.clearState(conversation.id);
      return { handled: true, reply: def.onCancel, terminal: true, scriptName: name };
    }
    // Неопределённый ответ — повторяем confirm.
    return {
      handled: true,
      reply: interpolateTemplate(def.confirm, slots),
      terminal: false,
      scriptName: name,
    };
  }

  private findTriggeredScript(
    userText: string,
    scripts: Record<string, ScriptSpec>,
  ): { name: string; def: ScriptSpec } | undefined {
    const text = userText.trim();
    if (!text) {
      return undefined;
    }
    for (const [name, def] of Object.entries(scripts)) {
      for (const pattern of def.trigger.intent) {
        try {
          if (new RegExp(pattern, "iu").test(text)) {
            return { name, def };
          }
        } catch (e) {
          this.logger.warn(
            `Script "${name}" invalid trigger regex "${pattern}": ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
    return undefined;
  }

  private async clearState(conversationId: string): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        activeScript: null,
        activeScriptState: null,
        activeScriptSlots: Prisma.JsonNull,
      },
    });
  }

  private readSlots(raw: unknown): ScriptSlots {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }
    const out: ScriptSlots = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") {
        out[k] = v;
      }
    }
    return out;
  }
}
