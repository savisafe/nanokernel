export type SafetyCategory = "medical" | "legal" | "financial" | "self_harm" | "injection";

export interface SafetyInResult {
  blocked: boolean;
  /** Категория, по которой блок (если blocked=true). */
  category?: SafetyCategory | "rate_limit";
  /** Текст ответа клиенту. */
  reply?: string;
  /** Что именно сматчилось (для логов/наблюдаемости). */
  matched?: string;
}

export interface SafetyOutResult {
  /** Финальный текст (возможно подрезан). */
  text: string;
  /** Был ли применён cap. */
  truncated: boolean;
  /** Перечень обнаруженных предупреждений (warn-only). */
  warnings: string[];
}

/** Дефолты ответов; могут перекрываться через guardrails.refuseReply / guardrails.rateLimitReply. */
export const DEFAULT_REFUSE_REPLIES: Record<SafetyCategory | "rate_limit", string> = {
  medical:
    "Я не консультирую по медицинским вопросам — рекомендую обратиться к врачу. Чем ещё могу помочь?",
  legal:
    "Это требует юридической консультации — обратитесь к юристу. Чем ещё могу помочь?",
  financial:
    "Я не даю советов по инвестициям и финансам — это к финансовому консультанту. Чем ещё могу помочь?",
  self_harm:
    "Я не могу помочь с этим запросом. Пожалуйста, обратитесь к специалисту или на горячую линию психологической помощи.",
  injection:
    "Извините, не могу выполнить такой запрос. Чем могу помочь по делу?",
  rate_limit:
    "Слишком много сообщений за короткое время. Подождите минуту и попробуйте снова.",
};
