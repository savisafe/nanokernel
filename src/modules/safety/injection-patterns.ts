/**
 * Регексы для детекции prompt injection. Все компилируются с флагами "iu".
 * Подобраны как наиболее распространённые формулировки в RU+EN; ложноположительные
 * на обычных запросах редки, но возможны — fallback здесь fail-safe (отказ).
 */
export const INJECTION_PATTERNS: readonly string[] = [
  // EN
  "ignore\\s+(all|previous|above|the|prior)\\s+(prior\\s+)?(instructions?|prompts?|messages?|context)",
  "disregard\\s+(the|previous|all|your)\\s+(instructions?|prompts?|rules?)",
  "forget\\s+(all|everything|your|previous|prior)\\s+(instructions?|context|rules?)",
  "you\\s+are\\s+(now|actually)\\s+(a|an|the)?\\s*[\\p{L}\\d_]+",
  "act\\s+as\\s+(a|an|the)?\\s*[\\p{L}\\d_]+",
  "pretend\\s+(to\\s+be|you\\s+are)\\s+",
  "system\\s+prompt",
  "your\\s+(real\\s+|true\\s+|original\\s+)?(instructions?|prompts?|rules?)",
  "new\\s+(instructions?|role|persona|rules?)",
  "override\\s+(your|the|all)\\s+(instructions?|rules?)",
  "jailbreak",
  "dan\\s+mode",
  "developer\\s+mode",

  // RU
  "забудь\\s+(все|всё|свои|предыдущие|прошлые)?\\s*(инструкции|настройки|правила|контекст)",
  "игнорируй\\s+(все|всё|предыдущие|свои)?\\s*(инструкции|правила|настройки)",
  "ты\\s+теперь\\s+(не\\s+[\\p{L}\\d_]+\\s+)?[\\p{L}\\d_]+",
  "представь(ся)?\\s+что\\s+ты",
  "играй\\s+(роль|за)",
  "веди\\s+себя\\s+как",
  "твои\\s+(настоящие|истинные|первоначальные)?\\s*(инструкции|правила|настройки)",
  "покажи\\s+(свой|твой)\\s+(промпт|систем[\\p{L}\\d_]+\\s+промпт)",
  "обход\\s+(инструкций|правил|защит)",
  "режим\\s+разработчика",
];
