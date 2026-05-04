import type { DialogServiceConfig } from "./dialog.config.types";

export const DIALOG_SUBSYSTEM_DEFAULTS: Omit<DialogServiceConfig, "systemPromptFrame" | "staticPromptSuffix"> = {
  diagnosticsDefaults: {
    stage: "contact",
    channel: "telegram",
  },
  templateStages: {
    contact: {
      replyLines: [
        "Спасибо за сообщение!",
        "Я помогу с консультацией и подбором решения.",
        "Расскажите, пожалуйста, какая задача сейчас самая приоритетная?",
      ],
    },
    qualification: {
      replyLines: [
        "Спасибо за обращение.",
        "Правильно понял, что запрос такой: \"{clientText}\"?",
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
