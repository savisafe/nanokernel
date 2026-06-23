/**
 * Контракт навыка (skill) — единица расширения бота. Skill вызывается LLM
 * через function/tool calling (OpenAI-compatible). Skills читают domain data
 * и/или выполняют действия; результат возвращается в LLM как tool message.
 */
export interface SkillContext {
  botId: string;
  conversationId?: string;
  channel?: string;
}

export interface SkillResult {
  /** Данные, которые LLM получит в content (будут сериализованы в JSON). */
  data: unknown;
  /** Если skill сам знает идеальный ответ — можно вернуть текст для прямой отдачи (минует LLM). */
  directReply?: string;
}

/**
 * Уровень доверия навыка. Используется как defense-in-depth поверх allowlist'а
 * (`bot.skills`): даже если конфиг включил навык, деплой может ограничить, навыки
 * какого происхождения вообще исполнимы (`guardrails.allowedSkillTrust`).
 *  - "builtin"     — поставляется в самом ядре (этот репозиторий);
 *  - "community"   — проверенный community-pack;
 *  - "third-party" — сторонний/непроверенный код.
 * Навыки без явного `trust` считаются "builtin" (исторические in-repo навыки).
 */
export type SkillTrust = "builtin" | "community" | "third-party";

/** Декларация возможностей навыка — для аудита и будущих policy-фильтров. */
export type SkillCapability = "read" | "write" | "network" | "pii" | "calendar";

export const DEFAULT_SKILL_TRUST: SkillTrust = "builtin";

export interface Skill {
  /** Имя skill в snake_case — оно же name функции в payload OpenAI tools. */
  readonly name: string;
  /** Человекочитаемое описание (LLM ориентируется по нему, когда выбирает tool). */
  readonly description: string;
  /** JSON Schema для параметров (поле `parameters` в OpenAI tools). */
  readonly parameters: Record<string, unknown>;
  /**
   * Если true — навык НЕ отдаётся LLM как tool (его дёргает FSM-скрипт напрямую
   * через registry.get). Нужно, чтобы FSM-only навыки (напр. book_slot) не
   * раздували tool-набор и не провоцировали маленькую модель на кривые tool_call.
   */
  readonly fsmOnly?: boolean;
  /** Уровень доверия (origin). По умолчанию "builtin". */
  readonly trust?: SkillTrust;
  /** Что навык делает (для аудита/логов). Опционально. */
  readonly capabilities?: readonly SkillCapability[];
  /** Выполнить skill с заранее разобранными аргументами. */
  execute(args: Record<string, unknown>, ctx: SkillContext): Promise<SkillResult>;
}

/** Формат, в котором skill отдаётся в LlmService (минимально достаточный для tool call). */
export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const SKILL_PROVIDERS_TOKEN = "SKILL_PROVIDERS_TOKEN";
