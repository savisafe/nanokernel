import type { FloodCategory, SafetyCategory } from "../safety/safety.types";

/**
 * Языковой пак — дом для всего, что в ядре раньше было захардкожено под русский:
 * regex-эвристики «глобального» запроса к базе, паттерны prompt-injection,
 * safety-ключевые слова и дефолтные тексты отказов. Ядро (DialogService,
 * SafetyInService) оперирует только этим контрактом и выбирает пак по языку бота —
 * так kernel остаётся language-agnostic, а новый язык = новый пак, а не правка движка.
 */

export type SafetyKeywordCategory = Exclude<SafetyCategory, "injection">;

/** Regex-эвристики, отличающие «расскажи о документе целиком» от обычного вопроса. */
export interface GlobalKnowledgePatterns {
  /** Полнотекстовые триггеры пересказа/резюме (любое совпадение → global). */
  summaryTriggers: readonly RegExp[];
  /** Зачины вида «о чём …», «про что …», «что за …». */
  aboutLead: RegExp;
  /** Якоря, указывающие на документ/базу/файл/материал. */
  docAnchor: RegExp;
  /** Глаголы глобального намерения (расскажи/опиши/суммируй/summary…). */
  globalIntentVerb: RegExp;
  /** Small-talk, который НЕ должен считаться запросом к базе («как дела»). */
  smallTalkExclusion: RegExp;
  /** Вопросительный зачин короткой реплики (что/кто/где…). */
  interrogativeLead: RegExp;
  /** Порог длины «короткой» реплики, на которой включается interrogativeLead. */
  maxShortQueryLen: number;
}

export interface LanguagePack {
  /** Код языка (BCP-47 база, напр. "ru"). */
  code: string;
  /**
   * Нормализация текста перед матчингом: lower-case + язык-специфичные сглаживания
   * (для ru — ё→е). Используется и retrieval-эвристикой, и safety-фильтром.
   */
  normalize(text: string): string;
  globalKnowledge: GlobalKnowledgePatterns;
  /** Паттерны prompt-injection (строки, компилируются с флагами "iu"). */
  injectionPatterns: readonly string[];
  /** Safety-ключевые слова по категориям (substring-матч по нормализованному тексту). */
  safetyKeywords: Record<SafetyKeywordCategory, readonly string[]>;
  /** Дефолтные тексты отказов; перекрываются per-bot через guardrails.*Reply. */
  refuseReplies: Record<SafetyCategory | FloodCategory, string>;
  /** Тексты для суммаризационной компакции контекста (см. ContextCompactionService). */
  compaction: CompactionStrings;
}

export interface CompactionStrings {
  /** System-инструкция модели-суммаризатору: как сжать старую переписку. */
  summaryInstruction: string;
  /** Префикс system-заметки с выжимкой, инжектируемой в основной промпт. */
  summaryNotePrefix: string;
  /** Метка реплики клиента в транскрипте для суммаризатора. */
  clientLabel: string;
  /** Метка реплики бота в транскрипте для суммаризатора. */
  assistantLabel: string;
}
