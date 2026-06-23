export interface DialogStageTemplates {
  replyLines: string[];
}

export interface DialogDiagnosticsDefaults {
  stage: string;
  channel: "telegram" | "whatsapp";
}

export interface DialogLlmContextMessages {
  envVarName: string;
  defaultLimit: number;
  min: number;
  max: number;
}

export interface DialogChunkDefaults {
  chunkSize: number;
  overlap: number;
  overlapClampSubtract: number;
}

export interface DialogChunkBoundaries {
  breakpoints: string[];
  minAdvanceChars: number;
}

export interface DialogRetrievalPresentation {
  defaultTopK: number;
  ragScoreLineTemplate: string;
  lexicalFragmentLineTemplate: string;
  chunkJoinSeparator: string;
  maxContextChars?: number;
  maxChunkChars?: number;
}

export interface DialogTokenization {
  minTokenLength: number;
  splitPattern: string;
  splitFlags: string;
  stopWords: string[];
}

/**
 * Минимальная конфигурация диалога: template для system prompt + опции retrieval/чанкинга/UX.
 * Адаптер BotConfig v2 строит template из persona/goals/guardrails автоматически.
 */
export interface DialogConfigFileJson {
  contextMessages?: number;
  systemPrompt: { template: string };
  templateStages?: Record<string, DialogStageTemplates>;
  fallbackNoKnowledgeReply?: string;
  chunkDefaults?: Partial<DialogChunkDefaults>;
  chunkBoundaries?: Partial<DialogChunkBoundaries>;
  retrievalPresentation?: Partial<DialogRetrievalPresentation>;
  tokenization?: Partial<DialogTokenization>;
}

/** Общие поля для lexical/RAG и лимитов (после resolve). */
export interface DialogSubsystemResolved {
  diagnosticsDefaults: DialogDiagnosticsDefaults;
  templateStages: Record<string, DialogStageTemplates>;
  fallbackNoKnowledgeReply: string;
  llmContextMessages: DialogLlmContextMessages;
  chunkDefaults: DialogChunkDefaults;
  chunkBoundaries: DialogChunkBoundaries;
  retrievalPresentation: DialogRetrievalPresentation;
  tokenization: DialogTokenization;
}

export interface EffectiveDialogRuntime extends DialogSubsystemResolved {
  systemPromptTemplate: string;
  /** Шаблон для строки этапа в system prompt (legacy-совместимость для template builder). */
  stageFrame: {
    openTopicsStageLine: string;
    funnelStageLineTemplate: string;
  };
}
