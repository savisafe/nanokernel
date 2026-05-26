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
});

export type BotConfigV2 = z.infer<typeof botConfigV2Schema>;
export type SnippetSpecV2 = z.infer<typeof snippetSpecSchema>;
