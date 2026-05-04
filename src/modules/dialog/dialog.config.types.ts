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
}

export interface DialogTokenization {
  minTokenLength: number;
  splitPattern: string;
  splitFlags: string;
  stopWords: string[];
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

/** Блок `dialog` в `config/configurations/<BOT_CONFIGURATION>.json`. */
export interface DialogServiceConfig {
  diagnosticsDefaults: DialogDiagnosticsDefaults;
  templateStages: Record<string, DialogStageTemplates>;
  fallbackNoKnowledgeReply: string;
  llmContextMessages: DialogLlmContextMessages;
  chunkDefaults: DialogChunkDefaults;
  chunkBoundaries: DialogChunkBoundaries;
  retrievalPresentation: DialogRetrievalPresentation;
  tokenization: DialogTokenization;
  systemPromptFrame: DialogSystemPromptFrame;
  staticPromptSuffix: DialogStaticPromptSuffix;
}
