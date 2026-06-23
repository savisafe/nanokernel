import type { PromptProfileFileJson } from "../prompt-profile/prompt-profile.types";
import type { DialogConfigFileJson } from "../dialog/dialog.config.types";
import type { SnippetSpec } from "../snippets/snippet.types";
import type { ScriptSpec } from "./v2/bot-config-v2.types";
import type { SafetyCategory } from "../safety/safety.types";
import type { SkillTrust } from "../skills/skill.contract";

export interface ResolvedBusinessService {
  name: string;
  description?: string;
  price?: string;
  duration?: string;
}

export interface ResolvedBusinessInfo {
  address?: string;
  phone?: string;
  onlineBookingUrl?: string;
  workingHours?: string;
  masters?: string[];
  services?: ResolvedBusinessService[];
}

export interface ResolvedPersona {
  role: string;
  managerName?: string;
  intro?: string;
}

export interface ResolvedBotLlmSettings {
  temperature?: number;
  maxTokens?: number;
  /** "off" — LLM без function-calling (skills дёргает FSM/роутер). По умолчанию поведение "auto". */
  toolCalling?: "auto" | "off";
  /** Сколько последних сообщений истории передавать LLM. Имеет приоритет над env LLM_CONTEXT_MESSAGES. */
  contextMessages?: number;
  /** Суммаризационная компакция контекста (см. ContextCompactionService). Выкл. по умолчанию. */
  compaction?: {
    enabled?: boolean;
    keepRecentMessages?: number;
    maxFetchMessages?: number;
    maxSummaryTokens?: number;
  };
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
  /** Разрешённые уровни доверия исполняемых навыков (см. BotConfig v2 guardrails.allowedSkillTrust). */
  allowedSkillTrust?: SkillTrust[];
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
  /**
   * Имя/intro менеджера (используется как `{managerName}` в snippets/intro
   * и в системном промпте «Тебя зовут …»).
   */
  persona?: ResolvedPersona;
  /**
   * Бизнес-факты бота (адрес/телефон/мастера/услуги). Доступны как
   * `{placeholders}` в snippets/intro и инжектятся в системный промпт.
   */
  businessInfo?: ResolvedBusinessInfo;
  /** Служебные уведомления (напр. о новой записи). */
  notifications?: ResolvedNotifications;
  /** Интеграция с CRM Mesto. */
  crm?: ResolvedCrm;
}

export interface ResolvedNotifications {
  /** Telegram chat id служебного чата для уведомлений; не задан — не шлём. */
  telegramChatId?: number;
}

export interface ResolvedCrm {
  provider: "mesto";
  /** Базовый URL Mesto без хвостового слеша. */
  baseUrl: string;
  /** Имя env-переменной с API-ключом бизнеса. */
  apiKeyEnv: string;
}
