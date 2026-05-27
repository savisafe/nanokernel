import type { PromptProfileFileJson } from "../prompt-profile/prompt-profile.types";
import type { DialogConfigFileJson } from "../dialog/dialog.config.types";
import type { SnippetSpec } from "../snippets/snippet.types";
import type { ScriptSpec } from "./v2/bot-config-v2.types";
import type { SafetyCategory } from "../safety/safety.types";

export interface ResolvedBotLlmSettings {
  temperature?: number;
  maxTokens?: number;
}

export interface ResolvedBurstLimit {
  messages: number;
  windowMs: number;
  cooldownSeconds: number;
  silent?: boolean;
  reply?: string;
}

export interface ResolvedRepeatLimit {
  occurrences: number;
  windowSeconds: number;
  cooldownSeconds: number;
  historySize?: number;
  nearDuplicatePrefix?: number;
  silent?: boolean;
  reply?: string;
}

export interface ResolvedBotGuardrails {
  safetyChecks?: SafetyCategory[];
  refuseReply?: string;
  rateLimitReply?: string;
  llmFallbackReply?: string;
  rateLimit?: { requests: number; windowSeconds: number };
  burstLimit?: ResolvedBurstLimit;
  repeatLimit?: ResolvedRepeatLimit;
  maxReplyChars?: number;
}

export interface ResolvedBotChannelTelegram {
  tokenEnv: string;
  webhookSecret: string;
  apiSecretToken?: string;
}

export interface ResolvedBotChannel {
  telegram?: ResolvedBotChannelTelegram;
}

export interface ResolvedBotConfiguration {
  id: string;
  llmPromptProfile: string;
  useRag: boolean;
  promptProfile?: PromptProfileFileJson;
  dialog?: DialogConfigFileJson;
  snippets?: SnippetSpec[];
  llm?: ResolvedBotLlmSettings;
  /** Имена включённых skills (резолв через SkillsRegistry в DialogService). */
  skills?: string[];
  /** FSM-скрипты бота (имя → спецификация). */
  scripts?: Record<string, ScriptSpec>;
  /** Программные ограничения (не путать с текстовыми гайдами в system prompt). */
  guardrails?: ResolvedBotGuardrails;
  /** Privacy-чувствительные настройки канала: token-env, webhook-secret. */
  channel?: ResolvedBotChannel;
}
