# Development Context

## Project
- Name: `ai-bot`
- Goal: Переиспользуемое ядро (платформа) для AI Telegram-ботов. Один процесс отдаёт N ботов через разные токены и webhook URL. Каждый бот = декларативный JSON-конфиг (BotConfig v2).
- Current stage: Platform core complete (Phases 0-9 of `docs/PROMPT_PLAN.md`). 4 рабочих референс-сборки: `salon-admin`, `pipe-sales`, `knowledge-consultant`, `open-topics`.

## Implemented

### BotConfig v2 — единый декларативный формат
- `src/modules/bot-configuration/v2/` — zod-схема + адаптер + system-prompt-builder.
- Поля: `persona` (role/language/tone/intro), `goals[]`, `guardrails` (refuseTopics, neverInvent, stickToScope, safetyChecks, refuseReply, rateLimitReply, rateLimit, burstLimit, repeatLimit, maxReplyChars), `knowledge.snippets[]`, `style` (humanLike, rules), `llm` (temperature, maxTokens, contextMessages), `skills[]`, `scripts` (FSM), `channel.telegram` (tokenEnv, webhookSecret, apiSecretToken).
- Адаптер собирает `dialog.systemPrompt.template` из декларативных полей; runtime читает один формат, без legacy ветки.
- Файлы: `config/configurations/<id>.json` со `schemaVersion: 2`. Legacy v1 формат снесён в Phase 9a.

### Multi-bot Telegram routing
- `POST /webhooks/telegram/:secret` → `BotConfigurationService.resolveByWebhookSecret(secret)` → pipeline с правильным `bot`.
- `BotConfigurationService.discoverAll()` сканирует все `*.json` при старте, индексирует по `webhookSecret`.
- `AsyncLocalStorage` (`telegram-bot-context.ts`) пробрасывает текущего bot в outbound (`sendMessage`, `editMessageText`, `getFile`, `sendChatAction`) — без явного параметра через 17+ сайтов.
- Worker BullMQ восстанавливает контекст из `botId` в `DialogInboundJob`.
- Legacy маршрут `POST /webhooks/telegram` сохранён для single-bot deploy (`BOT_CONFIGURATION` env + `TELEGRAM_BOT_TOKEN`).
- Скрипт `scripts/telegram-webhook.mjs` поддерживает `set/info/delete [<bot-id>]` — массово или per-bot.

### Dialog Pipeline (10 явных стадий)
```
[1] rate-limit → [2] burst-detect → [3] save user msg → [4] repeat-detect
  → [5] safety-in (content) → [6] FSM step → [7] snippet
  → [8] LLM (tools + streaming) → [9] safety-out → [10] save assistant msg
```
Каждая стадия может ответить и завершить ход. Антифлуд — раньше LLM и раньше БД (burst), повтор — после записи в БД (чтобы спам был виден в истории, но не уходил в LLM). FSM раньше snippet, snippet раньше LLM.

### Слои runtime

- **SnippetMatcherService** (`src/modules/snippets/`) — zero-token ответы. Три режима: `exact` (substring), `regex`, `keywords` (AND внутри группы, OR между). Per-bot кеш компилированных правил.
- **ScriptRunnerService** (`src/modules/scripts/`) — FSM. Триггер по regex `intent[]`, последовательный сбор слотов (с опц. regex-валидацией), `confirm`-шаг, dispatch skill при подтверждении. Состояние в `Conversation.activeScript / activeScriptState / activeScriptSlots`. CANCEL/YES/NO детекторы используют explicit suffix `[\s,.!?]|$` (не `\b` — кириллица).
- **SkillsRegistry + DomainDataService** (`src/modules/skills/`) — реестр через DI-токен `SKILL_PROVIDERS_TOKEN`. Реальные skills: `lookup_service` (salon), `lookup_product` (pipes), `book_slot` (FSM action — пишет в `Booking`). Данные: `config/data/<botId>/<entity>.json`.
- **LlmService** (`src/modules/llm/`) — OpenAI-compatible (`/chat/completions`). Tool calls (function calling), SSE streaming с `stream_options.include_usage`. `completeWithTools` лупит до 4 итераций, на последней — без tools для финального текста. `onTextDelta` callback в `LlmCompleteOptions` для streaming.
- **SafetyInService** (`src/modules/safety/`) — `checkRateLimit` (Redis fixed-window per `{bot,channel,user}`), `checkBurst` / `checkRepeat` (flood-защита, см. FloodProtectionService), `checkContent` (injection-regex RU+EN + topic-keywords для `medical/legal/financial/self_harm/injection`). Injection-паттерны используют `[\p{L}\d_]+` (`\w` в JS не покрывает кириллицу даже с `/u`). Opt-in через `guardrails.safetyChecks`.
- **FloodProtectionService** (`src/modules/safety/flood-protection.service.ts`) — два сигнала антифлуда поверх Redis:
  - **Burst** (`guardrails.burstLimit`): `ZSET safety:burst:{key}` + cooldown sentinel. Если ≥ `messages` событий за `windowMs` мс — блок и cooldown `cooldownSeconds`. Срабатывает ДО записи в БД.
  - **Repeat** (`guardrails.repeatLimit`): `LIST safety:repeat:{key}` хранит последние `historySize` хешей. Хеш — SHA1(base64url, 16 chars) от нормализованного текста (lower + `ё→е` + collapse whitespace + опц. prefix `nearDuplicatePrefix`). Если хеш встречается ≥ `occurrences` раз в окне — блок и cooldown. Запускается ПОСЛЕ записи в БД (повтор должен быть виден в истории).
  - Оба чека fail-open при ошибках Redis. На блоке можно ответить фиксированным текстом или молча (`silent: true`).
  - Категории `BotUsage.snippetId` для блоков: `"burst"`, `"repeat"` (рядом с существующим `"rate_limit"`).
- **SafetyOutService** — cap длины ответа (default 4000, override через `guardrails.maxReplyChars`).
- **BotUsageService** (`src/modules/bot-usage/`) — событие на каждый ход: `kind ∈ {snippet, llm, no_llm_fallback, fsm, safety_block}`. Парсит `usage` из ответа LLM. `summarize({botId, sinceHours})` для `GET /health/usage?bot=<id>&hours=<n>`.
- **DialogService** (`src/modules/dialog/`) — оркестратор pipeline. `process(input, { onLlmTextDelta? })` — стриминг callback прокидывается в LlmService.
- **TelegramService** (`src/modules/telegram/`) — placeholder-сообщение при первой стрим-дельте, throttled `editMessageText` ≥500ms, typing-indicator каждые 4 сек, idempotency по `messageId`, серийная обработка per `chatId` через `inboundChains`.

### Storage
- **PostgreSQL** (Prisma): `User`, `Conversation` (+ `activeScript/State/Slots` для FSM), `Message`, `ProcessedInboundMessage` (idempotency), `Booking` (FSM result), `BotUsage`.
- **Redis** — BullMQ `dialog-inbound` queue, per-user rate-limit (separate ioredis-коннект, fail-open).
- **sqlite-vec** — RAG индекс (in-memory, опц., `useRag` в config).
- Все legacy таблицы (`AdminUser`, `Tenant`, `BotConfiguration`, `PromptProfile`, `HandoffEvent`, ENUM `AdminRole`) удалены в Phase 9c миграцией `20260526150000_drop_legacy_models`.

### Per-bot LLM tuning
- `BotConfig.llm.{temperature, maxTokens, contextMessages}` прокидывается в `LlmService.complete(messages, options)`.
- Резолв: per-call override → env (`LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `LLM_CONTEXT_MESSAGES`) → default.
- Salon-admin: `temp=0.7` (тёплый). Pipe-sales: `temp=0.3` (точный). Knowledge-consultant: `temp=0.2`. Open-topics: `temp=0.8` (вариативный).

### 4 референсных бота
- **salon-admin** — администратор маникюрного салона. human-like. Snippets (`/help`, часы работы, прайс-редирект). Skill `lookup_service` для каталога. FSM `booking` (5 слотов: service/date/time/name/phone с regex-валидацией) → `book_slot` → запись в БД. Safety: `medical, injection`. Rate-limit 30/min.
- **pipe-sales** — менеджер труб «Профильмет». neutral. Snippets (включая regex для «каталог»). Skill `lookup_product` (фильтр по material/type/diameter/wallThickness). Safety: `legal, financial, injection`. Rate-limit 40/min.
- **knowledge-consultant** — formal, строгий по фактам. Guardrails: `neverInvent` нормы/числа/имена, `stickToScope`. Safety: `medical, legal, financial, injection`. `temperature=0.2`.
- **open-topics** — свободный диалог, human-like, все safety-checks включая `self_harm`. `temperature=0.8`.

## Architecture Decisions
- **Один JSON = один бот.** Декларация в `config/configurations/<id>.json`. Без скрытой сборки из нескольких файлов.
- **Multi-bot first-class.** Routing по URL secret; токен в env-переменной, имя которой задаётся в JSON. Один процесс — N ботов.
- **Декларативные guardrails ≠ только текст.** safety-checks в коде дублируют текстовые правила system prompt: модель может быть взломана, программный фильтр — нет.
- **Skills vs RAG.** Структурные данные (каталоги, услуги, прайсы) → skills через tool calling. Документы (свободный текст, регламенты) → RAG. Не смешивать.
- **FSM scripts ≠ stage в БД.** Бронирование = state machine с slot-filling + validation, не «просто промпт».
- **AsyncLocalStorage для bot context** в Telegram-стороне. Альтернатива — пробрасывать `bot` через 20+ сайтов — отвергнута.
- **Pipeline стадии явные.** Каждая стадия может ответить и завершить ход.
- **Versioning конфигов.** v1 legacy полностью снесён в Phase 9. Будущие изменения — `schemaVersion: 3+` с миграцией.
- **Streaming через editMessageText.** Placeholder при первой дельте, throttled edit ≥500ms. Совместимо с tool-loop (стрим включается на финальной итерации с текстом).

## Risks / Open Questions
- **RAG global index.** `RagService` строит индекс в памяти из глобального `BOT_CONFIGURATION` при старте. Для multi-bot с `useRag: true` на разных сборках — расхождение. Требуется per-bot индекс.
- **WhatsApp multi-bot.** Канал работает single-bot; нет `channel.whatsapp` в v2. Параллельная реализация по аналогии с Telegram — todo.
- **DB-backed configs.** Всё файловое. Нет CRUD-админа для онлайн-правки конфигов. Можно либо REST/JWT (решение было: не делать), либо построить бот-админ платформы.
- **Personal KB bot pattern.** `/new /done` flow удалён в Phase 9b. Если понадобится — строить чисто на v2 + skills + RAG с user-uploaded data, без legacy User-полей.
- **Pacing/split.** LLM-ответ обрезается на 4000 символов (Telegram-limit 4096). Split на несколько сообщений не реализован.
- **Cost estimation.** `BotUsage` считает токены, но не стоимость (требуются прайсы провайдеров).
- **Tenant isolation.** Сейчас `tenant ≈ bot`. Если придёт настоящий multi-tenant с разделением пользователей/доступа — нужно ввести `tenantId` в `User/Conversation/Message/Booking/BotUsage`.
- **Native modules.** `better-sqlite3` пересобирать при смене Node: `npm rebuild better-sqlite3`.
- **TELEGRAM_BOT_TOKEN env fallback.** Сохранён для legacy single-bot deploy через `POST /webhooks/telegram`. Окончательный снос — когда все продакшены перейдут на multi-bot маршрут.

## Change Log

Все Phase 0-9 выполнены 2026-05-26 (см. `docs/PROMPT_PLAN.md` для детального плана):

- **Phase 9c — `1e233ae`** Drop dead Prisma models (`AdminUser/Tenant/BotConfiguration/PromptProfile/HandoffEvent/AdminRole`), миграция `20260526150000_drop_legacy_models`. Drop `strictKnowledgeMode` runtime branch в `DialogService` (dead с Phase 9b). Drop npm deps: `@nestjs/jwt, @nestjs/passport, bcrypt, passport, passport-jwt` + types. `.env.example` переписан под multi-bot.
- **Phase 9b — `a059d6b`** Снос `/new /done` knowledge upload flow + mode-picker callback_query + document handling в Telegram. Удалены `User.{knowledgeScopeText, knowledgeDraft, telegramKnowledgeAwaiting, selectedBotConfigurationId}` (миграция `20260526140000_drop_knowledge_user_fields`). `TelegramService` переписан 773 → 297 строк. Удалён `DialogTelegramKnowledgeOnboarding` interface. `TelegramModule` больше не импортирует `DocumentIngestModule`.
- **Phase 9a — `7c7914e`** Migrate `knowledge-consultant + open-topics` to v2. Drop legacy `DialogServiceConfig/DialogStaticPromptSuffix/DialogSystemPromptFrame/DialogStyleVariant`. Drop `buildLlmSystemPromptStaticParts` (~110 LoC). Drop v1-парсер в `BotConfigurationService.load` — теперь только `schemaVersion: 2`. ~380 LoC net deletion.
- **Phase 8 — `f256b00`** LLM streaming. `LlmCompleteOptions.onTextDelta`. SSE-парсер `parseStreamingResponse`. `DialogService.process(input, progress?)`. `TelegramService`: placeholder + throttled `editMessageText` ≥500ms. `sendMessage` возвращает `messageId | null`.
- **Phase 7 — `9667fb9`** Multi-bot Telegram routing. `channel.telegram` в BotConfig v2. `POST /webhooks/telegram/:secret`. `AsyncLocalStorage` для bot context. `BotConfigurationService.discoverAll/resolveByWebhookSecret/listAll`. Worker восстанавливает context из `botId` в job. `scripts/telegram-webhook.mjs` обновлён под multi-bot.
- **Phase 6 — `216e57c`** Safety In/Out. Rate-limit (Redis sliding window, fail-open). Injection-regex (RU+EN, `[\p{L}\d_]+` вместо `\w`). Topic-keywords для 5 категорий. `guardrails.safetyChecks` opt-in. `SafetyOut` cap длины. Новый `kind: safety_block` в `BotUsage`.
- **Phase 5 — `ea62243`** FSM scripts. `ScriptRunnerService` (slot-filling, validation, confirm, dispatch). DSL `scripts.{trigger.intent, slots, order, confirm, onConfirm, onCancel}`. Prisma миграция `20260526130000_scripts_and_bookings`: `Conversation.activeScript/State/Slots` + `Booking`. `book_slot` skill.
- **Phase 4 — `9b5d824`** Skill contract + tool calling. `SkillsRegistry, DomainDataService, LookupServiceSkill, LookupProductSkill`. `LlmService.completeWithTools` с tool-loop (max 4 итерации). `BotConfig.skills`. Domain data в `config/data/<botId>/*.json`.
- **Phase 3 — `37093ee`** Token meter. `BotUsage` модель + миграция `20260526120000_bot_usage`. `LlmService` парсит `usage`. `recordSnippet/recordLlm/recordNoLlmFallback`. `GET /health/usage`.
- **Phase 2.5 — `aeccb9b`** Per-bot LLM tuning. `LlmCompleteOptions { temperature, maxTokens }`. Резолв per-call → env → default.
- **Phase 2 — `12ea5da`** BotConfig v2 schema (zod). Адаптер v2 → `ResolvedBotConfiguration`. Два референса: salon-admin, pipe-sales.
- **Phase 1 — `7d644d2`** Snippets layer (`@Global SnippetsModule`). `SnippetMatcherService` с тремя режимами и per-bot кешем. Fast-path в `DialogService.process()` до LLM.
- **Phase 0 — `54d8c11`** `docs/PROMPT_PLAN.md` — план 10 фаз.

История до этой ветки — в `git log` или предыдущих ревизиях этого файла. Ключевые точки до Phase 9: multi-mode bot с inline-выбором `/start`, `/new /done` knowledge upload flow, REST/JWT админ-панель — всё снесено в Phase 9.
