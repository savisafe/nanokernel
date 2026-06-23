import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  DEFAULT_SKILL_TRUST,
  LlmToolSpec,
  SKILL_PROVIDERS_TOKEN,
  Skill,
  SkillContext,
  SkillTrust,
} from "./skill.contract";

/** Сигнатура диспетчера tool-вызовов, ожидаемая LlmService.completeWithTools. */
export type SkillToolDispatcher = (name: string, args: Record<string, unknown>) => Promise<unknown>;

@Injectable()
export class SkillsRegistry {
  private readonly logger = new Logger(SkillsRegistry.name);
  private readonly byName = new Map<string, Skill>();

  constructor(@Inject(SKILL_PROVIDERS_TOKEN) skills: Skill[]) {
    for (const s of skills) {
      if (this.byName.has(s.name)) {
        this.logger.warn(`Skill duplicate name "${s.name}" — keeping the first registration.`);
        continue;
      }
      this.byName.set(s.name, s);
    }
    this.logger.log(`Registered skills: ${[...this.byName.keys()].join(", ") || "(none)"}`);
  }

  get(name: string): Skill | undefined {
    return this.byName.get(name);
  }

  /** Резолвит skills для конкретного бота по списку имён (если каких-то нет — лог и пропуск). */
  resolveForBot(skillNames: readonly string[] | undefined): Skill[] {
    if (!skillNames || skillNames.length === 0) {
      return [];
    }
    const out: Skill[] = [];
    for (const name of skillNames) {
      const skill = this.byName.get(name);
      if (skill) {
        out.push(skill);
      } else {
        this.logger.warn(`Skill not found: "${name}" — ignoring.`);
      }
    }
    return out;
  }

  /** Сериализация skill в OpenAI-совместимый tool spec. */
  toToolSpec(skill: Skill): LlmToolSpec {
    return {
      name: skill.name,
      description: skill.description,
      parameters: skill.parameters,
    };
  }

  /** Эффективный уровень доверия (навыки без явного trust считаются builtin). */
  trustOf(skill: Skill): SkillTrust {
    return skill.trust ?? DEFAULT_SKILL_TRUST;
  }

  /**
   * Строит диспетчер tool-вызовов, ЗАМКНУТЫЙ на конкретный набор навыков бота.
   *
   * Это контур доверия: модель (или prompt-injection, повторивший имя известного навыка)
   * не может выполнить навык, не включённый для этого бота — диспетчер ищет навык только
   * среди `allowed`, а не в глобальном реестре. Дополнительно — policy по trust:
   * если задан `allowedTrust`, навыки иного происхождения блокируются, даже будучи в allowlist'е.
   *
   * Неизвестный/заблокированный вызов не бросает, а возвращает `{ error }` — он уходит
   * в LLM как tool-результат, и модель формулирует корректный отказ вместо «техсбоя».
   */
  makeDispatcher(
    allowed: readonly Skill[],
    ctx: SkillContext,
    options?: { allowedTrust?: readonly SkillTrust[]; onExecute?: (name: string) => void },
  ): SkillToolDispatcher {
    const byName = new Map(allowed.map((s) => [s.name, s]));
    const allowedTrust = options?.allowedTrust;
    return async (name, args) => {
      const skill = byName.get(name);
      if (!skill) {
        this.logger.warn(
          `Skill call blocked: "${name}" is not enabled for bot=${ctx.botId} ` +
            `(model requested a tool outside the bot's allowlist).`,
        );
        return { error: `skill "${name}" is not enabled for this bot` };
      }
      if (allowedTrust && !allowedTrust.includes(this.trustOf(skill))) {
        this.logger.warn(
          `Skill call blocked by trust policy: "${name}" trust=${this.trustOf(skill)} ` +
            `not in [${allowedTrust.join(", ")}] (bot=${ctx.botId}).`,
        );
        return { error: `skill "${name}" is blocked by the deployment trust policy` };
      }
      options?.onExecute?.(name);
      const result = await skill.execute(args, ctx);
      return result.data;
    };
  }
}
