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
  telegramKnowledgeOnboarding: {
    welcomeStart: [
      "Привет! Помогаю находить ответы в ваших регламентах и документах: только факты из загруженного текста - без домыслов и общих фраз.",
      "",
      "Как работать: /new -> вставьте текст базы (Telegram может разбить длинную вставку на части - это нормально) -> /done. После этого задавайте вопросы - разберем пункты строго по вашему материалу.",
    ].join("\n"),
    newDocHint:
      "Режим нового документа. Отправьте текст базы знаний - можно несколькими сообщениями. Когда закончите, отправьте /done.",
    draftSavedAck:
      "Текст сохранен (учтены все последние сообщения). При необходимости пришлите еще или отправьте /done.",
    draftAckDebounceMs: 1800,
    emptyDone:
      "Текста пока нет. Отправьте хотя бы одно сообщение с текстом базы, затем снова /done.",
    saved: "База знаний сохранена. Задайте вопрос по этому материалу.",
    awaitingSlash:
      "Сейчас пришлите текст базы или завершите ввод командой /done. Другие команды с '/' здесь недоступны.",
    strictNoScopeAwaitingDraft:
      "Загрузка базы не завершена: отправьте текст документа или команду /done.",
    strictNoScopeNeedNew:
      "Чтобы отвечать по вашей базе знаний, отправьте /new и пришлите текст документа (можно частями), затем команду /done.",
  },
};
