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

export interface Skill {
  /** Имя skill в snake_case — оно же name функции в payload OpenAI tools. */
  readonly name: string;
  /** Человекочитаемое описание (LLM ориентируется по нему, когда выбирает tool). */
  readonly description: string;
  /** JSON Schema для параметров (поле `parameters` в OpenAI tools). */
  readonly parameters: Record<string, unknown>;
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
