import type { DialogSubsystemResolved } from "./dialog.config.types";

export const DIALOG_SUBSYSTEM_DEFAULTS: DialogSubsystemResolved = {
  diagnosticsDefaults: {
    stage: "contact",
    channel: "telegram",
  },
  templateStages: {
    // Используется как fallback, когда LLM недоступен (таймаут / отключён / API-ошибка).
    // Текст специально нейтральный — без «консультанта», который ломал персону каждого
    // бота. Боты могут переопределить через `guardrails.llmFallbackReply` в BotConfig v2.
    contact: {
      replyLines: [
        "Не получилось обработать сообщение прямо сейчас. Попробуйте написать ещё раз через минуту, пожалуйста.",
      ],
    },
    qualification: {
      replyLines: [
        "Не получилось обработать сообщение прямо сейчас. Попробуйте написать ещё раз через минуту, пожалуйста.",
      ],
    },
  },
  fallbackNoKnowledgeReply:
    "По этому запросу в подключённой базе не нашлось подходящего фрагмента. Переформулируйте вопрос или уточните тему — я подберу ответ из документа.",
  llmContextMessages: {
    envVarName: "LLM_CONTEXT_MESSAGES",
    defaultLimit: 16,
    min: 2,
    max: 50,
  },
  chunkDefaults: {
    chunkSize: 1400,
    overlap: 200,
    overlapClampSubtract: 50,
  },
  chunkBoundaries: {
    breakpoints: ["\n\n", "\n", ". ", "; ", ", "],
    minAdvanceChars: 200,
  },
  retrievalPresentation: {
    defaultTopK: 3,
    ragScoreLineTemplate: "[Релевантность: {scorePercent}%]\n{text}",
    lexicalFragmentLineTemplate: "[Фрагмент {id}, совпадений: {overlap}]\n{text}",
    chunkJoinSeparator: "\n\n---\n\n",
    maxContextChars: 5000,
    maxChunkChars: 1400,
  },
  tokenization: {
    minTokenLength: 2,
    splitPattern: "[^a-zа-я0-9.]+",
    splitFlags: "i",
    stopWords: [
      "и",
      "в",
      "на",
      "по",
      "с",
      "для",
      "к",
      "о",
      "об",
      "от",
      "до",
      "или",
      "что",
      "как",
      "какой",
      "какие",
      "это",
      "пункт",
      "подпункт",
    ],
  },
};
