/**
 * Параметры гибридного retrieval (вектор + BM25, слияние через Reciprocal Rank Fusion).
 * Все поля опциональны на входе; недостающие добираются дефолтами в RagService.
 */
export interface RetrievalFusionConfig {
  /** Вес векторного сигнала в RRF. */
  weightVector: number;
  /** Вес лексического (BM25) сигнала в RRF. */
  weightLexical: number;
  /** Константа k в формуле RRF: score = Σ wᵢ / (k + rank). */
  rrfK: number;
  /** Размер пула кандидатов из каждого сигнала = max(topK * multiplier, poolMin). */
  poolMultiplier: number;
  poolMin: number;
}

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
  /** Переопределения весов/пула гибридного поиска; что не задано — берётся из дефолтов RagService. */
  retrievalFusion?: Partial<RetrievalFusionConfig>;
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
  retrieval?: {
    topK?: number | string | null;
    chunkSize?: number | string | null;
    chunkOverlap?: number | string | null;
    fusion?: {
      weightVector?: number | string | null;
      weightLexical?: number | string | null;
      rrfK?: number | string | null;
      poolMultiplier?: number | string | null;
      poolMin?: number | string | null;
    } | null;
  } | null;
  retrievalChunkSize?: number | string | null;
  retrievalChunkOverlap?: number | string | null;
  retrievalTopK?: number | string | null;
  strictKnowledgeConversationalBypass?: {
    maxMessageLength?: number | string | null;
    patterns?: string[] | null;
  } | null;
  strictKnowledgeConversationalPromptAddendum?: string[] | null;
}
