/**
 * Snippet — короткий ответ, который отдаётся без обращения к LLM.
 * Применяется в pipeline до retrieval/LLM, экономит токены и латентность.
 *
 * Режимы матча:
 * - "exact":    включает подстроку (case-insensitive, ё → е).
 * - "regex":    тестируется RegExp (флаги по умолчанию "iu").
 * - "keywords": все слова из группы должны присутствовать в тексте.
 */
export type SnippetMatchMode = "exact" | "regex" | "keywords";

export interface SnippetSpec {
  id: string;
  mode: SnippetMatchMode;
  /** Группа паттернов; срабатывает любой (OR). Для "keywords" каждая строка — это набор слов (AND внутри). */
  match: string[];
  reply: string;
  /** Только для mode="regex". По умолчанию "iu". */
  flags?: string;
}

export interface CompiledSnippet {
  id: string;
  reply: string;
  test: (normalizedText: string) => boolean;
}

export interface SnippetHit {
  id: string;
  reply: string;
}
