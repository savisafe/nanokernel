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
  /** Опциональная фраза-приветствие при первом контакте. */
  intro: z.string().min(1).optional(),
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
  /** Лимит входящих сообщений per user (msg/min). */
  rateLimit: z
    .object({
      requests: z.number().int().positive(),
      windowSeconds: z.number().int().positive(),
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
});

const slotSpecSchema = z.object({
  /** Что спросить у клиента, когда подходим к этому слоту. */
  ask: z.string().min(1),
  /** Regex-валидация ввода (флаги "iu"). Пусто — принимаем любой непустой ответ. */
  validate: z.string().optional(),
  /** Сообщение при провале валидации; если не задано — re-ask с уточнением. */
  validateErrorReply: z.string().optional(),
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
});

export type BotConfigV2 = z.infer<typeof botConfigV2Schema>;
export type SnippetSpecV2 = z.infer<typeof snippetSpecSchema>;
export type ScriptSpec = z.infer<typeof scriptSpecSchema>;
export type SlotSpec = z.infer<typeof slotSpecSchema>;
