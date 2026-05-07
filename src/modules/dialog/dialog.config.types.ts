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

export interface DialogTelegramKnowledgeOnboarding {
  welcomeStart: string;
  newDocHint: string;
  draftSavedAck: string;
  draftAckDebounceMs: number;
  emptyDone: string;
  saved: string;
  awaitingSlash: string;
  strictNoScopeAwaitingDraft: string;
  strictNoScopeNeedNew: string;
}

export interface DialogSystemPromptFrame {
  openTopicsStageLine: string;
  funnelStageLineTemplate: string;
  knowledgeBlockIntro: string;
  assembledTemplate: string;
}

export interface DialogStyleVariant {
  sectionTitle: string;
  sharedBullets: string[];
  lastBulletHumanLike: string;
  lastBulletDefault: string;
}

export interface DialogStaticPromptSuffix {
  defaultLanguage: string;
  defaultPersonaTemplate: string;
  mainLanguageLineTemplate: string;
  primaryGoalsHeader: string;
  goalItemPrefix: string;
  openTopicsPrimaryGoal: string;
  funnelPrimaryGoal: string;
  servicesHighlightHeader: string;
  topicHeader: string;
  topicOutOfScopeGuidance: string;
  forbiddenSectionHeader: string;
  forbiddenItemPrefix: string;
  neverDoSectionHeader: string;
  neverDoItemPrefix: string;
  scopeConnectedIntro: string;
  strictKnowledgeBullets: string[];
  bookingSectionHeader: string;
  humanLikeSectionHeader: string;
  humanLikeBullets: string[];
  styleLeadHumanLike: string;
  styleLeadDefault: string;
  openTopicsStyle: DialogStyleVariant;
  funnelStyle: DialogStyleVariant;
  additionalStyleRulePrefix: string;
}

export interface DialogServiceConfig {
  diagnosticsDefaults: DialogDiagnosticsDefaults;
  templateStages: Record<string, DialogStageTemplates>;
  fallbackNoKnowledgeReply: string;
  llmContextMessages: DialogLlmContextMessages;
  chunkDefaults: DialogChunkDefaults;
  chunkBoundaries: DialogChunkBoundaries;
  retrievalPresentation: DialogRetrievalPresentation;
  tokenization: DialogTokenization;
  telegramKnowledgeOnboarding: DialogTelegramKnowledgeOnboarding;
  systemPromptFrame: DialogSystemPromptFrame;
  staticPromptSuffix: DialogStaticPromptSuffix;
}

/** Короткий `dialog`: один шаблон system prompt + опции; остальное подставляется из кода (defaults). */
export interface DialogConfigMinimalFile {
  contextMessages?: number;
  systemPrompt: { template: string };
  templateStages?: Record<string, DialogStageTemplates>;
  fallbackNoKnowledgeReply?: string;
  chunkDefaults?: Partial<DialogChunkDefaults>;
  chunkBoundaries?: Partial<DialogChunkBoundaries>;
  retrievalPresentation?: Partial<DialogRetrievalPresentation>;
  tokenization?: Partial<DialogTokenization>;
  telegramKnowledgeOnboarding?: Partial<DialogTelegramKnowledgeOnboarding>;
}

export type DialogConfigFileJson = DialogServiceConfig | DialogConfigMinimalFile;

/** Общие поля для lexical/RAG и лимитов (после resolve). */
export type DialogSubsystemResolved = Omit<DialogServiceConfig, "systemPromptFrame" | "staticPromptSuffix">;

export type EffectiveDialogRuntime =
  | ({
      systemKind: "legacy";
      systemPromptFrame: DialogSystemPromptFrame;
      staticPromptSuffix: DialogStaticPromptSuffix;
    } & DialogSubsystemResolved)
  | ({
      systemKind: "template";
      systemPromptTemplate: string;
      stageFrame: Pick<DialogSystemPromptFrame, "openTopicsStageLine" | "funnelStageLineTemplate">;
    } & DialogSubsystemResolved);
