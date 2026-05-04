export interface ResolvedLlmPromptProfile {
  id: string;
  companyName: string;
  persona?: string;
  language?: string;
  primaryGoals?: string[];
  topic?: string;
  servicesHighlight?: string;
  forbiddenTopics: string[];
  neverDo?: string[];
  bookingAndContact?: string;
  additionalStyleRules?: string[];
  humanLikeMode?: boolean;
  openTopicsMode?: boolean;
  scopeText?: string;
  strictKnowledgeMode?: boolean;
  noKnowledgeReply?: string;
  retrievalChunkSize?: number;
  retrievalChunkOverlap?: number;
  retrievalTopK?: number;
  strictKnowledgeConversationalBypass?: {
    maxMessageLength: number;
    patterns: RegExp[];
  };
  strictKnowledgeConversationalPromptAddendumLines?: string[];
}

export interface PromptProfileFileJson {
  companyName?: string;
  persona?: string | null;
  language?: string | null;
  primaryGoals?: string[];
  topic?: string | null;
  servicesHighlight?: string | null;
  forbiddenTopics?: string[];
  neverDo?: string[];
  bookingAndContact?: string | null;
  additionalStyleRules?: string[];
  humanLikeMode?: boolean | string;
  openTopicsMode?: boolean | string;
  scopeText?: string | null;
  scopeFile?: string | null;
  strictKnowledgeMode?: boolean | string;
  noKnowledgeReply?: string | null;
  retrievalChunkSize?: number | string | null;
  retrievalChunkOverlap?: number | string | null;
  retrievalTopK?: number | string | null;
  strictKnowledgeConversationalBypass?: {
    maxMessageLength?: number | string | null;
    patterns?: string[] | null;
  } | null;
  strictKnowledgeConversationalPromptAddendum?: string[] | null;
}
