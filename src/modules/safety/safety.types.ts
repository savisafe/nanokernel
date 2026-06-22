export type SafetyCategory = "medical" | "legal" | "financial" | "self_harm" | "injection";

/** Категории flood-защиты (срабатывают на уровне темпа/повтора, а не содержания). */
export type FloodCategory = "rate_limit" | "burst" | "repeat";

export interface SafetyInResult {
  blocked: boolean;
  /** Категория, по которой блок (если blocked=true). */
  category?: SafetyCategory | FloodCategory;
  /** Текст ответа клиенту. Может быть пустой строкой при silent-режиме. */
  reply?: string;
  /** Что именно сматчилось (для логов/наблюдаемости). */
  matched?: string;
  /**
   * Если true — ответ не отправлять клиенту (полное молчание).
   * Используется для антифлуда: атакующему не показываем, что попал в фильтр.
   */
  silent?: boolean;
}

export interface SafetyOutResult {
  /** Финальный текст (возможно подрезан). */
  text: string;
  /** Был ли применён cap. */
  truncated: boolean;
  /** Перечень обнаруженных предупреждений (warn-only). */
  warnings: string[];
}

// Дефолтные тексты отказов переехали в языковой пак (см. modules/language/packs/ru.pack.ts,
// поле refuseReplies). Per-bot override — через guardrails.refuseReply / rateLimitReply.
