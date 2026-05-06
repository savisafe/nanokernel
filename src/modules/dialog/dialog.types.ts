import type { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import type { ResolvedLlmPromptProfile } from "../prompt-profile/prompt-profile.types";

export type ChannelType = "telegram" | "whatsapp";

export interface DialogInput {
  channel: ChannelType;
  externalUserId: string;
  text: string;
}

export interface DialogOutput {
  replyText: string;
  stage: string;
}

export interface KnowledgeChunkRuntime {
  id: number;
  text: string;
  tokens: Set<string>;
}

/** Снимок ресурсов диалога для одного запуска (прод: дефолт из env/файлов; админ: из БД/файлов). */
export interface DialogRuntimeSnapshot {
  profile: ResolvedLlmPromptProfile;
  bot: ResolvedBotConfiguration;
  llmSystemPromptPrefix: string;
  llmSystemPromptSuffix: string;
  knowledgeChunks: KnowledgeChunkRuntime[];
  /** Пользовательская база (Telegram): не смешивать с глобальным RAG-индексом на старте */
  disableRag?: boolean;
}

export interface DialogDiagnosticChunk {
  id?: number;
  text: string;
  score?: number;
  overlap?: number;
}

export interface DialogDiagnostics {
  systemPrompt: string;
  knowledgeContext?: string;
  chunks: DialogDiagnosticChunk[];
  retrievalMode: "none" | "lexical" | "rag";
}

export interface DialogOutputWithDiagnostics extends DialogOutput {
  diagnostics: DialogDiagnostics;
}
