import { z } from "zod";

/**
 * BotConfig v2 — единый декларативный формат описания бота.
 *
 * Цель: один JSON = один бот, минимум служебных полей, понятная семантика.
 * Все технические поля промпта (templateStages, systemPromptFrame, …) ушли в адаптер.
 *
 * Файлы: `config/configurations/<id>.json` со `schemaVersion: 2`.
 */

const snippetSpecSchema = z.object({
  id: z.string().min(1),
  mode: z.enum(["exact", "regex", "keywords"]),
  match: z.array(z.string().min(1)).min(1),
  reply: z.string().min(1),
  flags: z.string().optional(),
});

const personaSchema = z.object({
  /** Кто бот: «Администратор маникюрного салона Лотос». */
  role: z.string().min(1),
  /** Язык ответов: "ru" по умолчанию. */
  language: z.string().min(2).optional(),
  /** Тон: human — как живой человек, neutral — нейтральный, formal — деловой. */
  tone: z.enum(["human", "neutral", "formal"]).optional(),
  /**
   * Имя онлайн-менеджера/администратора, под которым представляется бот.
   * Используется как `{managerName}` в `intro` и в `snippets[*].reply`,
   * а также инжектится в системный промпт фразой «Тебя зовут {managerName}».
   * Один источник истины — поменял здесь, и имя обновилось везде.
   */
  managerName: z.string().min(1).optional(),
  /** Опциональная фраза-приветствие при первом контакте. Поддерживает {placeholders}. */
  intro: z.string().min(1).optional(),
});

const businessServiceSchema = z.object({
  /** Название процедуры/товара/услуги (например, «Оформление бровей»). */
  name: z.string().min(1),
  /** Свободное описание/детали (опц.). */
  description: z.string().optional(),
  /** Цена в свободной форме: «6 000 ₸», «от 5 000 тг», «по запросу». */
  price: z.string().optional(),
  /** Длительность процедуры (опц.): «60 мин», «1.5 часа». */
  duration: z.string().optional(),
});

const businessInfoSchema = z.object({
  /** Адрес студии/салона/офиса (используется в `{address}` и в системном промпте). */
  address: z.string().optional(),
  /** Контактный телефон (используется в `{phone}`). */
  phone: z.string().optional(),
  /** URL для онлайн-записи (используется в `{onlineBookingUrl}`). */
  onlineBookingUrl: z.string().optional(),
  /** Время/график работы свободной строкой (используется в `{workingHours}`). */
  workingHours: z.string().optional(),
  /** Имена мастеров/сотрудников (доступны в `{masters}` через ", "-join). */
  masters: z.array(z.string().min(1)).optional(),
  /**
   * Услуги с ценами. Доступны как `{servicesList}` (форматированный markdown-список),
   * а также целиком уходят в системный промпт, чтобы LLM не выдумывал цены.
   */
  services: z.array(businessServiceSchema).optional(),
});

const guardrailsSchema = z.object({
  /** Темы, на которые бот отказывается отвечать (вежливо). */
  refuseTopics: z.array(z.string().min(1)).optional(),
  /** Поля/факты, которые нельзя выдумывать (цены, адрес, имена). */
  neverInvent: z.array(z.string().min(1)).optional(),
  /** Если true — бот не уходит от своей роли и темы, даже если просят. */
  stickToScope: z.boolean().optional(),
  /** Программные проверки безопасности (фильтр в коде, не только промпт). */
  safetyChecks: z
    .array(z.enum(["medical", "legal", "financial", "self_harm", "injection"]))
    .optional(),
  /** Текст отказа при срабатывании safety-чека (любой категории кроме rate_limit). */
  refuseReply: z.string().min(1).optional(),
  /** Текст отказа при срабатывании rate-limit. */
  rateLimitReply: z.string().min(1).optional(),
  /**
   * Текст-fallback, когда LLM недоступен (таймаут / API-ошибка / отключён через env).
   * Если не задан — используется нейтральный дефолт из DIALOG_SUBSYSTEM_DEFAULTS.
   * Стоит писать в персоне бота: «Похоже, у меня технический сбой, напишите через минуту».
   */
  llmFallbackReply: z.string().min(1).optional(),
  /** Лимит входящих сообщений per user (msg/min). */
  rateLimit: z
    .object({
      requests: z.number().int().positive(),
      windowSeconds: z.number().int().positive(),
    })
    .optional(),
  /**
   * Burst-детектор: ловит резкие всплески (несколько сообщений за секунды).
   * Дополняет `rateLimit` (тот считает суммарно за окно, а здесь — плотность).
   */
  burstLimit: z
    .object({
      /** Сколько сообщений в окне `windowMs` уже считаются burst'ом. */
      messages: z.number().int().min(2),
      /** Окно наблюдения в миллисекундах. */
      windowMs: z.number().int().min(100),
      /** Длительность cooldown после срабатывания (секунд). */
      cooldownSeconds: z.number().int().positive(),
      /** Если true — на блоке отвечать пустотой (для скрытности фильтра). */
      silent: z.boolean().optional(),
      /** Per-category override текста ответа. Иначе — DEFAULT_REFUSE_REPLIES.burst. */
      reply: z.string().min(1).optional(),
    })
    .optional(),
  /**
   * Detect повторов: одинаковые/похожие сообщения подряд.
   * Хеш считается по нормализованному тексту (lower + trim + collapse whitespace).
   */
  repeatLimit: z
    .object({
      /** Сколько повторов одного хеша в недавней истории считаются спамом. */
      occurrences: z.number().int().min(2),
      /** Окно подсчёта (секунд). История хранится не дольше. */
      windowSeconds: z.number().int().positive(),
      /** Длительность cooldown после срабатывания (секунд). */
      cooldownSeconds: z.number().int().positive(),
      /** Сколько последних сообщений держать в истории (для подсчёта повторов). */
      historySize: z.number().int().min(2).max(50).optional(),
      /**
       * Сравнивать по первым N символам нормализованного текста (near-duplicate).
       * Пусто — сравнение по полному хешу.
       */
      nearDuplicatePrefix: z.number().int().min(1).max(200).optional(),
      /** Если true — на блоке отвечать пустотой. */
      silent: z.boolean().optional(),
      /** Per-category override текста ответа. Иначе — DEFAULT_REFUSE_REPLIES.repeat. */
      reply: z.string().min(1).optional(),
    })
    .optional(),
  /** Cap на длину LLM-ответа (символов). */
  maxReplyChars: z.number().int().positive().optional(),
});

const knowledgeSchema = z.object({
  snippets: z.array(snippetSpecSchema).optional(),
  // documents/data — placeholder для будущих фаз
});

const styleSchema = z.object({
  /** «Как живой человек»: тёплый тон, минимум канцелярита. */
  humanLike: z.boolean().optional(),
  /** Дополнительные правила стиля. */
  rules: z.array(z.string().min(1)).optional(),
});

const llmSchema = z.object({
  /** Сэмплирование. По умолчанию env LLM_TEMPERATURE. Per-bot wiring — следующая фаза. */
  temperature: z.number().min(0).max(2).optional(),
  /** Лимит токенов на completion. */
  maxTokens: z.number().int().positive().optional(),
  /** Сколько сообщений истории передавать LLM. */
  contextMessages: z.number().int().min(2).max(50).optional(),
  /** "off" — не давать LLM function-calling (skills дёргает FSM/роутер). По умолчанию "auto". */
  toolCalling: z.enum(["auto", "off"]).optional(),
});

const channelTelegramSchema = z.object({
  /** Имя env-переменной с Telegram bot token. JSON не должен содержать сам токен. */
  tokenEnv: z.string().min(1),
  /** Уникальный секрет в URL вебхука: POST /webhooks/telegram/:secret. */
  webhookSecret: z.string().min(8),
  /** Опциональный X-Telegram-Bot-Api-Secret-Token заголовок (verify on incoming). */
  apiSecretToken: z.string().min(1).optional(),
});

const channelSchema = z.object({
  telegram: channelTelegramSchema.optional(),
});

const slotSpecSchema = z.object({
  /** Что спросить у клиента, когда подходим к этому слоту. */
  ask: z.string().min(1),
  /** Regex-валидация ввода (флаги "iu"). Пусто — принимаем любой непустой ответ. */
  validate: z.string().optional(),
  /** Сообщение при провале валидации; если не задано — re-ask с уточнением. */
  validateErrorReply: z.string().optional(),
  /**
   * Regex (флаги "iu") для предзаполнения слота из триггер-сообщения и недавней
   * истории клиента. Capture-группа 1 — значение слота; если групп нет — берётся
   * совпадение целиком. Извлечённое значение всё равно проходит `validate`.
   */
  extract: z.string().optional(),
  /** true — слот необязателен (в conversational-режиме не входит в required для записи). */
  optional: z.boolean().optional(),
});

const scriptSpecSchema = z.object({
  description: z.string().optional(),
  trigger: z.object({
    /** Regex-паттерны, по любому совпадению скрипт запускается. */
    intent: z.array(z.string().min(1)).min(1),
  }),
  slots: z.record(z.string().min(1), slotSpecSchema),
  /** Порядок прохождения слотов (имена должны быть из slots). */
  order: z.array(z.string().min(1)).min(1),
  /** Сообщение-подтверждение со {slot} плейсхолдерами. */
  confirm: z.string().min(1),
  onConfirm: z.object({
    /** Имя skill, которому передаются собранные слоты. */
    skill: z.string().min(1),
    /** Текст при успехе ({slot} плейсхолдеры доступны). */
    successReply: z.string().min(1),
    /** Текст при ошибке выполнения skill. */
    errorReply: z.string().min(1),
  }),
  /** Текст при отмене клиентом. */
  onCancel: z.string().min(1),
  /**
   * Сколько неудачных попыток ввода одного слота допустимо до эскалации.
   * По умолчанию 2 (см. ScriptRunnerService). При превышении FSM завершается
   * сообщением `onMaxAttempts` и управление возвращается LLM.
   */
  maxSlotAttempts: z.number().int().min(1).max(10).optional(),
  /**
   * Текст эскалации, когда клиент не смог заполнить слот за `maxSlotAttempts`
   * попыток. Поддерживает {placeholders} из businessInfo (напр. {onlineBookingUrl}).
   * Если не задан — FSM просто завершается без спец-сообщения.
   */
  onMaxAttempts: z.string().min(1).optional(),
  /**
   * Опционально (conversational-режим): имя skill для проверки расписания (calendar).
   * Движок зовёт его, когда известен день, и отдаёт LLM РЕАЛЬНЫЕ свободные окна —
   * чтобы бот отвечал корректно («есть 10:00, 12:00»), а не выдумывал.
   */
  availabilitySkill: z.string().min(1).optional(),
  /**
   * Опционально: LLM-извлечение намерения и слотов из СВОБОДНОЙ речи (вместо хрупких
   * regex-триггеров и regex-валидации). Доменно-нейтральный движок строит промпт из
   * этого блока — никакого хардкода в ядре.
   *  - `intent`: что хочет клиент (для классификации «этот сценарий / нет»);
   *  - `fields`: карта «имя слота → подсказка LLM, как извлечь/нормализовать значение».
   * Ключи `fields` ДОЛЖНЫ совпадать с именами слотов. Поддерживает {placeholders}
   * businessInfo ({masters}, {servicesList}, {workingHours}…) — интерполируются при адаптации.
   */
  extraction: z
    .object({
      intent: z.string().min(1),
      fields: z.record(z.string().min(1), z.string().min(1)),
    })
    .optional(),
});

const notificationsSchema = z.object({
  /**
   * Telegram chat id служебного чата (админ/мастера) для уведомлений о событиях —
   * напр. о новой записи. Если не задан — уведомления не отправляются.
   */
  telegramChatId: z.number().int().optional(),
});

/**
 * Региональные настройки бизнеса. Не фиксируемся на Казахстане/тенге в коде —
 * валюта, часовой пояс и локаль форматирования задаются здесь per-business.
 */
const regionSchema = z.object({
  /** ISO 3166-1 alpha-2 («KZ», «RU», «US»). Дефолтная страна для нормализации телефона в E.164. */
  country: z.string().length(2).optional(),
  /** IANA tz («Asia/Almaty», «Europe/Moscow»). Используется при синхронизации записей во внешние CRM. */
  timezone: z.string().min(1).optional(),
  /** ISO-4217 («KZT», «RUB», «USD»). Валюта суммы записи (`Booking.amount`). */
  currency: z.string().length(3).optional(),
  /** BCP-47 («ru-RU», «ru-KZ») для форматирования чисел/денег. По умолчанию — `ru-RU`. */
  locale: z.string().min(2).optional(),
});

/**
 * Интеграция с CRM Mesto. Сам ключ в JSON НЕ хранится — только имя env-переменной
 * (как `channel.telegram.tokenEnv`). Ключ per-business, бизнес определяется ключом.
 */
const crmSchema = z.object({
  provider: z.literal("mesto"),
  /** Базовый URL Mesto без хвостового слеша, напр. https://mesto.example.com. */
  baseUrl: z.string().url(),
  /** Имя env-переменной с API-ключом (`mst_live_...`). */
  apiKeyEnv: z.string().min(1),
});

export const botConfigV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  persona: personaSchema,
  goals: z.array(z.string().min(1)).default([]),
  guardrails: guardrailsSchema.optional(),
  knowledge: knowledgeSchema.optional(),
  style: styleSchema.optional(),
  llm: llmSchema.optional(),
  /** Имена skills, которые включены для этого бота (зарегистрированы в SkillsRegistry). */
  skills: z.array(z.string().min(1)).optional(),
  /** FSM-скрипты: ключ — имя сценария ("booking"), значение — спецификация. */
  scripts: z.record(z.string().min(1), scriptSpecSchema).optional(),
  /**
   * Бизнес-информация: адрес, телефон, мастера, услуги с ценами.
   * Все поля доступны как `{placeholders}` в intro/snippets и инжектятся
   * в системный промпт как факты (чтобы LLM не выдумывал).
   */
  businessInfo: businessInfoSchema.optional(),
  /** Привязка к каналам: tokenEnv + webhookSecret per channel. */
  channel: channelSchema.optional(),
  /** Служебные уведомления (напр. о новой записи в служебный Telegram-чат). */
  notifications: notificationsSchema.optional(),
  /** Интеграция с CRM Mesto (чтение расписания + запись/отмена/перенос). */
  crm: crmSchema.optional(),
});

export type BotConfigV2 = z.infer<typeof botConfigV2Schema>;
export type CrmSpec = z.infer<typeof crmSchema>;
export type SnippetSpecV2 = z.infer<typeof snippetSpecSchema>;
export type ScriptSpec = z.infer<typeof scriptSpecSchema>;
export type SlotSpec = z.infer<typeof slotSpecSchema>;
