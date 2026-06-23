import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SkillsRegistry } from "../skills/skills-registry.service";
import { interpolateTemplate } from "../dialog/dialog-template.utils";
import type { ScriptSpec, SlotSpec } from "../bot-configuration/v2/bot-config-v2.types";
import {
  SCRIPT_STATE_COLLECTING,
  SCRIPT_STATE_CONFIRM,
  SCRIPT_STATE_SLOT_PREFIX,
  ScriptSlots,
  ScriptStepInput,
  ScriptStepOutcome,
} from "./script.types";
import { SlotExtractorService } from "./slot-extractor.service";

@Injectable()
export class ScriptRunnerService {
  private readonly logger = new Logger(ScriptRunnerService.name);

  // ВАЖНО: \b в JS работает только для ASCII «слов» — для кириллицы используем явный
  // suffix: пробел/пунктуация/конец строки.
  private static readonly CANCEL_RE =
    /^\s*(отмена|отмени(ть|те)?|стоп|не\s+надо|передума(л|ла)|cancel|stop)(?:[\s,.!?]|$)/iu;
  private static readonly YES_RE =
    /^\s*(да|ок(ей)?|верно|согласен|согласна|подтверждаю|подтвердить|конечно|yes|y|\+)(?:[\s,.!?]|$)/iu;
  private static readonly NO_RE = /^\s*(нет|неа|не\s+верно|неправильно|no|n|-)(?:[\s,.!?]|$)/iu;

  /** Неудачных попыток на слот до эскалации, если в конфиге не задано иное. */
  private static readonly DEFAULT_MAX_SLOT_ATTEMPTS = 2;
  /** Сколько последних сообщений клиента сканируем для предзаполнения слотов. */
  private static readonly PREFILL_HISTORY_LIMIT = 10;
  /** Разделитель счётчика попыток в state: "slot:master#2". */
  private static readonly ATTEMPT_SEP = "#";

  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: SkillsRegistry,
    private readonly extractor: SlotExtractorService,
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
      // Conversational-режим (скрипт с `extraction`): копим слоты и уступаем ход LLM,
      // пока не собрано всё для записи. Линейный FSM — только для скриптов без extraction.
      if (def.extraction) {
        return this.conversationalStep(
          conversation,
          bot.id,
          conversation.activeScript,
          def,
          userText,
        );
      }
      return this.continueActive(conversation, bot.id, conversation.activeScript, def, userText);
    }

    // Вход в сценарий БЕЗ хардкода триггеров: для каждого скрипта с блоком `extraction`
    // (он описан в КОНФИГЕ) спрашиваем LLM — подходит ли реплика под его намерение, и
    // заодно извлекаем слоты. Regex-триггеры остаются дешёвым фолбэком (LLM off/сбой).
    for (const [scriptName, def] of Object.entries(scripts)) {
      if (!def.extraction) continue;
      const ex = await this.extractor.extract(def, userText);
      if (ex?.intentMatch) {
        return this.conversationalStart(conversation, bot.id, scriptName, def, ex.slots);
      }
    }

    const triggered = this.findTriggeredScript(userText, scripts);
    if (!triggered) {
      return { handled: false };
    }
    return this.activate(conversation, triggered.name, triggered.def, userText);
  }

  private async activate(
    conversation: ScriptStepInput["conversation"],
    name: string,
    def: ScriptSpec,
    triggerText: string,
    extractedSlots?: ScriptSlots,
  ): Promise<ScriptStepOutcome> {
    const firstSlot = def.order[0];
    if (!firstSlot || !def.slots[firstSlot]) {
      this.logger.warn(
        `Script "${name}" has empty order or missing first slot — ignoring trigger.`,
      );
      return { handled: false };
    }

    // Предзаполняем слоты тем, что клиент уже назвал. Если есть LLM-извлечение — берём из
    // него (нормализованные значения из любой формулировки); иначе — regex-фолбэк по истории.
    const prefilled = extractedSlots
      ? this.prefillFromExtracted(name, def, extractedSlots)
      : await this.prefillSlots(conversation.id, name, def, triggerText);
    const firstUnfilled = def.order.find((slot) => !(slot in prefilled));

    if (!firstUnfilled) {
      // Всё уже названо — сразу к подтверждению.
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          activeScript: name,
          activeScriptState: SCRIPT_STATE_CONFIRM,
          activeScriptSlots: prefilled as unknown as Prisma.InputJsonValue,
        },
      });
      return {
        handled: true,
        reply: interpolateTemplate(def.confirm, prefilled),
        terminal: false,
        scriptName: name,
      };
    }

    const firstSpec = def.slots[firstUnfilled];
    if (!firstSpec) {
      this.logger.warn(`Script "${name}" order references missing slot "${firstUnfilled}".`);
      return { handled: false };
    }
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        activeScript: name,
        activeScriptState: this.slotState(firstUnfilled),
        activeScriptSlots: prefilled as unknown as Prisma.InputJsonValue,
      },
    });
    return {
      handled: true,
      reply: firstSpec.ask,
      terminal: false,
      scriptName: name,
    };
  }

  /**
   * Извлекает значения слотов из триггер-сообщения и последних реплик клиента,
   * используя per-slot `extract` regex. Извлечённое значение всё равно проходит
   * `validate`, поэтому мусор не просочится. Самое свежее упоминание — в приоритете.
   */
  private async prefillSlots(
    conversationId: string,
    name: string,
    def: ScriptSpec,
    triggerText: string,
  ): Promise<ScriptSlots> {
    const hasExtractors = def.order.some((slot) => def.slots[slot]?.extract);
    if (!hasExtractors) {
      return {};
    }
    const history = await this.prisma.message.findMany({
      where: { conversationId, role: "client" },
      orderBy: { createdAt: "desc" },
      take: ScriptRunnerService.PREFILL_HISTORY_LIMIT,
    });
    const candidates = [triggerText, ...history.map((m) => m.text)];

    const prefilled: ScriptSlots = {};
    for (const slotName of def.order) {
      const spec = def.slots[slotName];
      if (!spec?.extract) {
        continue;
      }
      let re: RegExp;
      try {
        re = new RegExp(spec.extract, "iu");
      } catch (e) {
        this.logger.warn(
          `Script "${name}" slot "${slotName}" invalid extract regex "${spec.extract}": ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
      for (const text of candidates) {
        const m = re.exec(text);
        if (!m) {
          continue;
        }
        const captured = (m[1] ?? m[0]).trim();
        if (!captured || !this.slotValueValid(name, slotName, spec.validate, captured)) {
          continue;
        }
        prefilled[slotName] = captured;
        break;
      }
    }
    return prefilled;
  }

  /**
   * Префилл слотов из LLM-извлечения (intent+слоты). Значения уже нормализованы моделью
   * («днём в 2»→«14:00»), но всё равно сверяем с validate-regex как страховкой от мусора.
   */
  private prefillFromExtracted(name: string, def: ScriptSpec, slots: ScriptSlots): ScriptSlots {
    const out: ScriptSlots = {};
    for (const slotName of def.order) {
      const v = slots[slotName];
      if (!v) continue;
      const spec = def.slots[slotName];
      if (spec && this.slotValueValid(name, slotName, spec.validate, v)) {
        out[slotName] = v;
      }
    }
    return out;
  }

  // ===== Conversational-режим (скрипты с блоком `extraction`) =====
  // Пока слотов для записи не хватает — копим извлечённое и уступаем ход LLM (он отвечает
  // гибко: на вопросы, не-меню, мягко ведёт к недостающему). Когда всё собрано →
  // детерминированное подтверждение → onConfirm.skill (book_slot → CRM).

  /** Старт: первая реплика с booking-намерением. */
  private async conversationalStart(
    conversation: ScriptStepInput["conversation"],
    botId: string,
    name: string,
    def: ScriptSpec,
    exSlots: ScriptSlots,
  ): Promise<ScriptStepOutcome> {
    return this.decideBooking(
      conversation,
      botId,
      name,
      def,
      this.validForSlots(name, def, exSlots),
    );
  }

  /** Очередная реплика в активной записи. */
  private async conversationalStep(
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
    // Контекст последней реплики бота — чтобы короткие ответы («Савелий», «15:00») легли в нужный слот.
    const lastBot = await this.prisma.message.findFirst({
      where: { conversationId: conversation.id, role: "assistant" },
      orderBy: { createdAt: "desc" },
    });
    const ex = await this.extractor.extract(def, userText, lastBot?.text?.slice(0, 200));
    const merged: ScriptSlots = {
      ...this.readSlots(conversation.activeScriptSlots),
      ...this.validForSlots(name, def, ex?.slots ?? {}),
    };

    if (conversation.activeScriptState === SCRIPT_STATE_CONFIRM) {
      if (ScriptRunnerService.YES_RE.test(userText)) {
        return this.bookConfirmed(conversation, botId, name, def, merged);
      }
      if (ScriptRunnerService.NO_RE.test(userText)) {
        await this.saveBookingState(conversation.id, name, SCRIPT_STATE_COLLECTING, merged);
        return {
          handled: false,
          llmNote:
            "[Запись] Клиент сказал, что-то не так — спроси по-человечески, что именно изменить (день, время, услугу или мастера).",
        };
      }
      // Не «да/нет» в подтверждении — возможно, поправил слот; пересчитываем ниже.
    }
    return this.decideBooking(conversation, botId, name, def, merged);
  }

  /**
   * Решает ход: всё собрано → просим LLM подтвердить запись своими словами; иначе копим.
   * В ОБОИХ случаях ход у LLM с контекстом (что собрано / что нужно / реальные окна
   * календаря) — бот ведёт диалог как менеджер, без шаблонных фраз.
   */
  private async decideBooking(
    conversation: ScriptStepInput["conversation"],
    botId: string,
    name: string,
    def: ScriptSpec,
    merged: ScriptSlots,
  ): Promise<ScriptStepOutcome> {
    const required = def.order.filter((s) => !def.slots[s]?.optional);
    const missing = required.filter((s) => !merged[s]);
    const avail = await this.availabilityNote(botId, def, merged);
    const known = def.order
      .filter((s) => merged[s])
      .map((s) => `${s}=${merged[s]}`)
      .join(", ");

    if (missing.length === 0) {
      const display: ScriptSlots = { ...merged };
      for (const s of def.order) if (!display[s]) display[s] = "любой";
      await this.saveBookingState(conversation.id, name, SCRIPT_STATE_CONFIRM, display);
      return {
        handled: false,
        llmNote:
          "[Идёт запись клиента — веди как живой менеджер, своими словами, без шаблонных фраз.]\n" +
          `Все данные собраны: ${known}.\n${avail}` +
          "Кратко повтори клиенту детали записи человеческим языком и спроси, всё ли верно (да/нет). Ничего не выдумывай.",
      };
    }

    await this.saveBookingState(conversation.id, name, SCRIPT_STATE_COLLECTING, merged);
    return {
      handled: false,
      llmNote:
        "[Идёт запись клиента — веди как живой менеджер по контексту, без шаблонных фраз и без дословного повтора вопроса.]\n" +
        (known ? `Уже известно: ${known}.\n` : "") +
        `Ещё нужно узнать у клиента: ${missing.join(", ")}.\n${avail}` +
        "Ответь на вопросы клиента, если есть, и естественно уточни недостающее (по 1–2 за раз). Свободное время предлагай ТОЛЬКО из окон выше — не выдумывай.",
    };
  }

  /** Дёргает calendar-skill (если задан и известен день) → строка с РЕАЛЬНЫМИ окнами для LLM. */
  private async availabilityNote(
    botId: string,
    def: ScriptSpec,
    merged: ScriptSlots,
  ): Promise<string> {
    if (!def.availabilitySkill || !merged.date) return "";
    const skill = this.skills.get(def.availabilitySkill);
    if (!skill) return "";
    try {
      const res = await skill.execute(
        { service: merged.service, master: merged.master, date: merged.date },
        { botId },
      );
      const data = res.data as
        | { days?: Array<{ status?: string; times?: string[]; closedReason?: string }> }
        | undefined;
      const day = data?.days?.[0];
      if (!day) return "";
      if (day.status !== "open") {
        return `На «${merged.date}» приёма нет (${day.closedReason ?? "выходной"}) — предложи другой день.\n`;
      }
      const times = day.times ?? [];
      if (times.length === 0)
        return `На «${merged.date}» свободных окон нет — предложи другой день.\n`;
      const who = merged.master && merged.master !== "любой" ? ` (мастер ${merged.master})` : "";
      return `Свободные окна на «${merged.date}»${who}: ${times.join(", ")}.\n`;
    } catch {
      return "";
    }
  }

  /** Подтверждение получено — дёргаем skill записи (book_slot → CRM). */
  private async bookConfirmed(
    conversation: ScriptStepInput["conversation"],
    botId: string,
    name: string,
    def: ScriptSpec,
    merged: ScriptSlots,
  ): Promise<ScriptStepOutcome> {
    const skill = this.skills.get(def.onConfirm.skill);
    let success = false;
    if (!skill) {
      this.logger.warn(`Script "${name}" onConfirm.skill="${def.onConfirm.skill}" not found.`);
    } else {
      try {
        const result = await skill.execute(merged, { botId, conversationId: conversation.id });
        const data = result.data as { ok?: boolean } | undefined;
        success = data?.ok !== false;
      } catch (e) {
        this.logger.warn(
          `Script "${name}" onConfirm.skill="${def.onConfirm.skill}" threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    await this.clearState(conversation.id);
    return {
      handled: true,
      reply: interpolateTemplate(
        success ? def.onConfirm.successReply : def.onConfirm.errorReply,
        merged,
      ),
      terminal: true,
      scriptName: name,
    };
  }

  private async saveBookingState(
    conversationId: string,
    name: string,
    state: string,
    slots: ScriptSlots,
  ): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        activeScript: name,
        activeScriptState: state,
        activeScriptSlots: slots as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** Оставляет только извлечённые значения, валидные для своих слотов (страховка от мусора). */
  private validForSlots(name: string, def: ScriptSpec, slots: ScriptSlots): ScriptSlots {
    const out: ScriptSlots = {};
    for (const [k, v] of Object.entries(slots)) {
      if (!v) continue;
      const spec = def.slots[k];
      if (spec && this.slotValueValid(name, k, spec.validate, v)) out[k] = v;
    }
    return out;
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
      const { slotName, attempts } = this.parseSlotState(state);
      const spec = def.slots[slotName];
      if (!spec) {
        this.logger.warn(`Script "${name}" missing slot "${slotName}" — clearing state.`);
        await this.clearState(conversation.id);
        return { handled: false };
      }
      // LLM-нормализация значений слотов из свободной речи («днём в 2»→«14:00») вместо regex —
      // по fields-подсказкам из конфига скрипта (extraction).
      const ex = await this.extractor.extract(def, userText);
      return this.handleSlot(
        conversation,
        name,
        def,
        slots,
        slotName,
        spec,
        userText,
        attempts,
        ex?.slots,
      );
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
    attempts: number,
    exSlots?: Record<string, string>,
  ): Promise<ScriptStepOutcome> {
    // Значение слота: нормализованное из LLM-извлечения (если модель его поняла) либо сырой
    // текст. Ключи = имена слотов (из конфига extraction.fields). name/phone — обычно как есть.
    const extracted: Record<string, string> = exSlots ?? {};
    const value = (extracted[slotName] ?? userText).trim();
    if (!value || !this.slotValueValid(name, slotName, spec.validate, value)) {
      return this.failSlot(conversation, name, def, slots, slotName, spec, attempts);
    }

    // Мержим прочие слоты, названные в этой же реплике («2 июня в 3» на вопрос о времени).
    const updatedSlots: ScriptSlots = { ...slots, [slotName]: value };
    for (const [field, v] of Object.entries(extracted)) {
      if (field === slotName || !v || field in updatedSlots) continue;
      const fSpec = def.slots[field];
      if (fSpec && this.slotValueValid(name, field, fSpec.validate, v)) {
        updatedSlots[field] = v;
      }
    }
    const idx = def.order.indexOf(slotName);
    // Пропускаем уже заполненные (предзаполненные) слоты дальше по порядку.
    const nextSlotName =
      idx >= 0 ? def.order.slice(idx + 1).find((s) => !(s in updatedSlots)) : undefined;

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
          activeScriptState: this.slotState(nextSlotName),
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

  /**
   * Неуспешный ввод слота: считаем попытки. До лимита — повторяем подсказку;
   * на лимите — эскалируем (onMaxAttempts) либо отдаём ход обратно LLM (handled:false).
   */
  private async failSlot(
    conversation: ScriptStepInput["conversation"],
    name: string,
    def: ScriptSpec,
    slots: ScriptSlots,
    slotName: string,
    spec: SlotSpec,
    attempts: number,
  ): Promise<ScriptStepOutcome> {
    const nextAttempts = attempts + 1;
    const maxAttempts = def.maxSlotAttempts ?? ScriptRunnerService.DEFAULT_MAX_SLOT_ATTEMPTS;

    if (nextAttempts >= maxAttempts) {
      await this.clearState(conversation.id);
      if (def.onMaxAttempts) {
        return {
          handled: true,
          reply: interpolateTemplate(def.onMaxAttempts, slots),
          terminal: true,
          scriptName: name,
        };
      }
      // Нет спец-сообщения — отдаём ход дальше (snippet/LLM) с тем же userText.
      return { handled: false };
    }

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { activeScriptState: this.slotState(slotName, nextAttempts) },
    });
    return {
      handled: true,
      reply: spec.validateErrorReply ?? `Не понял — повторите, пожалуйста. ${spec.ask}`,
      terminal: false,
      scriptName: name,
    };
  }

  private slotValueValid(
    name: string,
    slotName: string,
    validate: string | undefined,
    value: string,
  ): boolean {
    if (!validate) {
      return true;
    }
    let re: RegExp;
    try {
      re = new RegExp(validate, "iu");
    } catch (e) {
      // Битый regex в конфиге — не блокируем клиента, пропускаем значение.
      this.logger.warn(
        `Script "${name}" slot "${slotName}" invalid regex "${validate}": ${e instanceof Error ? e.message : String(e)}`,
      );
      return true;
    }
    return re.test(value);
  }

  private slotState(slotName: string, attempts = 0): string {
    return attempts > 0
      ? `${SCRIPT_STATE_SLOT_PREFIX}${slotName}${ScriptRunnerService.ATTEMPT_SEP}${attempts}`
      : `${SCRIPT_STATE_SLOT_PREFIX}${slotName}`;
  }

  private parseSlotState(state: string): { slotName: string; attempts: number } {
    const body = state.slice(SCRIPT_STATE_SLOT_PREFIX.length);
    const sepIdx = body.indexOf(ScriptRunnerService.ATTEMPT_SEP);
    if (sepIdx === -1) {
      return { slotName: body, attempts: 0 };
    }
    const parsed = Number(body.slice(sepIdx + 1));
    return {
      slotName: body.slice(0, sepIdx),
      attempts: Number.isFinite(parsed) ? parsed : 0,
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
        this.logger.warn(`Script "${name}" onConfirm.skill="${def.onConfirm.skill}" not found.`);
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
        reply: interpolateTemplate(
          success ? def.onConfirm.successReply : def.onConfirm.errorReply,
          slots,
        ),
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
