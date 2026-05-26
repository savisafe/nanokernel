export type BotUsageKind = "snippet" | "llm" | "no_llm_fallback" | "fsm";

export interface BotUsageLlmTokens {
  promptTokens?: number;
  completionTokens?: number;
}

export interface BotUsageSummary {
  total: number;
  byKind: Record<BotUsageKind, number>;
  promptTokens: number;
  completionTokens: number;
  /** Сколько ответов закрыто без обращения к LLM (snippet + no_llm_fallback). */
  zeroTokenReplies: number;
}
