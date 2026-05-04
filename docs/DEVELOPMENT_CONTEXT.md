# Development Context

## Project
- Name: `ai-bot`
- Goal: Гибкий AI-bot для выполнения разносторонних задач в зависимости от установленной конфигурации через мессенджер или API.
- Current stage: MVP core — входящие сообщения по умолчанию через **BullMQ** (быстрый ACK вебхука); при `DIALOG_QUEUE_ENABLED=false` — синхронная обработка в вебхуке без Redis. HTTP-админка и JWT-аутентификация **сняты** (см. «Implemented» и Change Log).

## Implemented
- Инициализирован backend-каркас (NestJS + TypeScript).
- Добавлены `docker-compose.yml` (PostgreSQL + Redis; без устаревшего ключа `version`, без фиксированных `container_name` — имена контейнеров задаёт Compose) и `prisma/schema.prisma`.
- **BullMQ** (`DialogQueueModule`): очередь `dialog-inbound`. После idempotency вебхук Telegram/WhatsApp ставит job и отвечает провайдеру; `DialogQueueWorkerService` в том же процессе вызывает `TelegramService` / `WhatsAppService` → `processInboundQueued` (LLM + отправка). `TelegramModule` / `WhatsAppModule` **экспортируют** сервисы для внедрения в воркер. Переменные: `DIALOG_QUEUE_ENABLED`, `DIALOG_QUEUE_WORKER_ENABLED`, `DIALOG_QUEUE_CONCURRENCY`, опционально `DIALOG_QUEUE_ATTEMPTS`, `DIALOG_QUEUE_BACKOFF_MS`, `REDIS_PASSWORD`. **Custom `jobId`**: `telegram-<messageId>`, `whatsapp-<id>` (символ `:` в id запрещён BullMQ). При ошибке `enqueue` — `IdempotencyService.revert` для повторной доставки вебхука.
- Мониторинг очереди: `GET /health/queue` (счётчики Redis; при недоступности Redis — 503). В dev логируются постановка в очередь и события воркера `[Queue] job active` / `job completed`.
- Добавлен WhatsApp webhook модуль (`GET` verify + `POST` receive/send text).
- Добавлен Telegram webhook модуль (`POST` receive/send text).
- Добавлены команды управления Telegram webhook и `.gitignore` для защиты `.env`.
- Добавлен общий `DialogService` для единых ответов в Telegram/WhatsApp.
- Добавлено сохранение входящих/исходящих сообщений в PostgreSQL через Prisma.
- Применена первая Prisma миграция `init` к PostgreSQL.
- Этап диалога хранится в `conversation.stage` (по умолчанию `contact`); переходы по ключевым словам из внешних JSON не используются.
- Таблица `handoff_events` в схеме Prisma сохранена; основной поток `DialogService.process()` не создаёт записи handoff (раньше триггеры задавались в JSON sales-scripts).
- Добавлена idempotency-обработка входящих сообщений (Telegram/WhatsApp) по `messageId`.
- Добавлена проверка подписи WhatsApp webhook (`X-Hub-Signature-256` + `WHATSAPP_APP_SECRET`).
- Применена Prisma миграция `add_idempotency` для таблицы обработанных входящих сообщений.
- Подключена локальная LLM через  API (`POST {LLM_BASE_URL}/chat/completions`): **LM Studio** и аналоги; `model` резолвится один раз на процесс из **`GET …/models`** (первая модель без подстроки `embed` в `id`). Переменные **`LLM_MODEL` / `LLM_API_KEY`** не используются — достаточно **`LLM_BASE_URL`** (и опционально `LLM_MAX_TOKENS`, `LLM_TEMPERATURE`, …). При выключенной или недоступной LLM — короткие встроенные шаблоны в `DialogService`.
- Профили системного промпта (`PromptProfileModule`): JSON в `config/prompt-profiles/`; идентификатор профиля задаётся через сборку бота (см. ниже) или fallback `LLM_PROMPT_PROFILE`; лимит токенов на completion — **`LLM_MAX_TOKENS`** (если не задано в env — в `LlmService` по умолчанию **2048**, чтобы модели с `reasoning_content` не обрезались с пустым `content`).
- **Конфигурации бота** (`BotConfigurationModule`, глобальный модуль): файл `config/configurations/<BOT_CONFIGURATION>.json` (переменная окружения `BOT_CONFIGURATION`, по умолчанию `default`). В сборке задаётся **`llmPromptProfile`** (имя файла без `.json` из `prompt-profiles/`) и опционально **`useRag`**. Примеры сборок: `daria-mokko`, `test-saas`, `test-fitness`, `open-topics`.
- Расширенные поля профиля промпта: `persona`, `primaryGoals`, `servicesHighlight`, `neverDo`, `bookingAndContact`, `additionalStyleRules`, `language`, флаг **`humanLikeMode`** (более «живой» тон в системном промпте). Парсинг в `PromptProfileService`, сборка текста — `DialogService.buildSystemPrompt`.
- Добавлен свободный режим диалога **`openTopicsMode`** в профиле промпта: без жёсткой рамки темы и без блока «правила продаж» в системном промпте; `DialogService.buildSystemPrompt` в этом режиме подставляет нейтральный маркер свободного диалога вместо этапа воронки.
- Свободный режим: `config/prompt-profiles/open-topics.json`, `config/configurations/open-topics.json`; активация через `BOT_CONFIGURATION=open-topics`.
- Резолв пользователя для диалога: `findFirst` по `channel` + `externalId` и `create` с обработкой гонки `P2002` (вместо `upsert` по составному unique в типах клиента).
- Логи цепочки сообщения в Telegram/WhatsApp: шаги `1/3`–`3/3` (получено → диалог → отправка в API), разбивка времени и total «webhook → ответ ушёл в канал»; только при `NODE_ENV=development` (`src/modules/shared/is-development.ts`).
- `LLM_CONTEXT_MESSAGES` ограничивает глубину истории в запросе к LLM; `LLM_TIMEOUT_MS` — `AbortSignal.timeout` на HTTP-вызов провайдера, при срыве — встроенные шаблоны в `DialogService`.
- Документация запуска: корневой `README.md` и этот файл; обзор потока — раздел «Архитектура / вебхуки» в [docs/README.md](README.md).
- **RAG** (`RagModule`, `RagService`): опционально для сборки бота (`useRag` в `config/configurations/<id>.json`). Векторный поиск по тексту из `scopeFile` профиля: эмбеддинги `@xenova/transformers` (MiniLM), SQLite in-memory + `sqlite-vec`; `DialogService.retrieveKnowledgeContext` при `useRag: true` вызывает `ragService.search`, иначе — лексический матч по чанкам. `DialogModule` импортирует `RagModule`, чтобы `RagService` инжектился в `DialogService`.
- Режим **строгой базы знаний** в профиле промпта: `strictKnowledgeMode`, опциональный `scopeFile` (длинный текст в контекст LLM / индексация), `noKnowledgeReply` при отсутствии релевантных фрагментов.
- **Разговорный обход** strict-режима (`strictKnowledgeConversationalBypass` в `config/prompt-profiles/*.json`): список regex-строк (флаг `u` при компиляции в `PromptProfileService`), `maxMessageLength`, опционально `strictKnowledgeConversationalPromptAddendum` — строки к system prompt. Дефолтные паттерны и текст доп. блока — `src/modules/prompt-profile/strict-knowledge-conversational.defaults.ts`. Важно: в JS **не использовать `\b` в паттернах под кириллицу** (word boundary только для ASCII-«слов»); при совпадении обхода поиск по БЗ для этого сообщения **не** вызывается, чтобы случайные чанки не тянули ответ «нет в базе».
- Скрипты инфраструктуры: `npm run db:up` / `db:down` — `docker compose` для PostgreSQL и Redis. Подключение Prisma при старте: повторные попытки с паузой (`PRISMA_CONNECT_MAX_ATTEMPTS`, `PRISMA_CONNECT_RETRY_DELAY_MS`), чтобы пережить медленный старт контейнера.
- **Админ API снят**: каталоги `src/modules/admin/` и `src/modules/auth/` удалены; в **`AppModule`** нет `AdminModule` / `AuthModule`. Эндпоинты вида `/admin/*` и JWT (**`POST /admin/auth/login`**, **`POST /admin/auth/refresh`**) не обслуживаются.
- **`ConfigManagementModule`** (`src/modules/config-management/`) **не импортируется** в `AppModule`; сервис по-прежнему реализует разрешение бандла по id из БД или файлов (`config/configurations/`, `config/prompt-profiles/`), опциональный кэш **`CONFIG_MGMT_CACHE_TTL_MS`** — на случай подключения из скриптов или будущего REST.
- **Prisma** (миграция `20260424120000_admin_and_config_management` и последующие): в схеме по-прежнему есть **`AdminUser`**, **`Tenant`**, записи **`BotConfiguration`** / **`PromptProfile`** в БД; прод-поток бота **не** использует админ-CRUD — только **`BOT_CONFIGURATION`**, файлы `config/**` и таблица **`User`** (клиенты каналов). Таблица **`SalesScript`** удалена миграцией `20260428120000_remove_sales_script`.
- **`DialogService`**: при старте собирается **`defaultSnapshot`** (профиль + bot из env и файлов); **`process()`** использует только его. Методы **`composeSnapshot`** и **`runDiagnosticTurn`** остаются в коде (внутренняя диагностика, unit-тесты); публичного HTTP для тестового диалога нет.
- В **`.env.example`** могут остаться переменные **`JWT_*`** от старой админки — для текущего приложения не обязательны, пока JWT не вернут.

## In Progress
- Уточнение эскалации к живому менеджеру и уведомлений (без JSON-триггеров в репозитории).

## Next
1. Настроить Telegram/WhatsApp production webhook URLs.
2. Добавить уведомление менеджера при необходимости эскалации (новый канал, не завязанный на удалённые sales-scripts).
3. Добавить retry/backoff для неуспешной отправки сообщений в каналы.
4. Добавить базовые метрики по диалогам и стадиям в БД.
5. При необходимости снова включить панель конфигурации: восстановить модули admin/auth или вынести CRUD в отдельный сервис; учесть `ConfigManagementService` и модели Prisma.

## Architecture Decisions
- Единый слой каналов: адаптеры для каждого мессенджера.
- Отдельный слой диалоговой логики: LLM + поле `conversation.stage` в БД; офлайн-fallback — встроенные шаблоны в коде.
- Отдельный слой знаний/контента: FAQ, офферы, возражения.
- Рамка LLM (компания, тема, запреты, опциональный `scopeFile`, режим «человечнее», strict/RAG и др.) — в файлах `config/prompt-profiles/*.json`; длинный текст не хранить в `.env`.
- Для режима «на любые темы» использовать профиль с `openTopicsMode=true` (сборка `open-topics`), а не `default`.
- Переключение «какой бот запущен» — **`BOT_CONFIGURATION`** → один JSON в `config/configurations/` задаёт профиль промпта (`llmPromptProfile`) и опционально `useRag`; **`LLM_PROMPT_PROFILE`** — запасной вариант, если в сборке не задан `llmPromptProfile`.
- Основной backend: NestJS (TypeScript), REST + webhook endpoints.
- Хранение состояния и истории: PostgreSQL (через Prisma ORM).
- Очереди: Redis + BullMQ — очередь входящих диалогов `dialog-inbound` (`DialogQueueModule`); опционально отдельный инстанс API с `DIALOG_QUEUE_WORKER_ENABLED=false` и выделенный воркер — по мере масштабирования.
- `HealthModule` подключает `DialogQueueModule` для эндпоинта метрик очереди.
- Прод-конфиг не зависит от HTTP-админки: `BotConfigurationService`, вебхуки и воркер очереди читают **`BOT_CONFIGURATION`** и файлы на диске. Данные `BotConfiguration` / `PromptProfile` в PostgreSQL остаются опциональным слоем (история миграций + возможное использование `ConfigManagementService` вне текущего REST).
- Multi-tenant: в схеме есть **`Tenant`** и nullable **`tenantId`** у `BotConfiguration` / `PromptProfile`; резолв по тенанту в коде пока не включён.

## Risks / Open Questions
- Выбор провайдера для WhatsApp (официальный API vs BSP).
- Требования по хранению персональных данных.
- Границы полномочий AI и правила эскалации человеку.
- Выбор финального поставщика LLM и политика контроля затрат.
- Диагностика с **`useRag: true`**: при несовпадении индекса `RagService` с выбранным профилем retrieval может быть нерепрезентативным (если вызывать `runDiagnosticTurn` вручную в коде/тестах).

## Change Log
- 2026-05-05: `docs/README.md` — в схеме потока входящего сообщения убраны устаревшие упоминания HTTP-админки и `POST /admin/test-dialog`; описано переключение поведения через **`BOT_CONFIGURATION`** и JSON в `config/configurations/`, `config/prompt-profiles/`.
- 2026-05-05: Удалены модули **`AdminModule`** и **`AuthModule`** (`src/modules/admin/`, `src/modules/auth/`): нет REST `/admin/configurations`, `/admin/prompt-profiles`, `/admin/test-dialog`, `/admin/auth/*`. В **`AppModule`** остались только модули каналов, диалога, очереди, RAG и т.д. **`ConfigManagementModule`** в приложении не регистрируется; код в `config-management/` сохранён. **`DialogService`**: `composeSnapshot` / `runDiagnosticTurn` без публичного эндпоинта. Документация (`DEVELOPMENT_CONTEXT.md`) приведена в соответствие.
- 2026-04-28: Документация LLM: `docs/README.md` — LM Studio, только `LLM_BASE_URL`, выбор модели из `/models` без embedding, `LLM_MAX_TOKENS` / reasoning; таблица «типичные проблемы». `DEVELOPMENT_CONTEXT.md` — то же в «Implemented» и этот пункт changelog.
- 2026-04-28: Удалены sales-scripts: Prisma-модель и таблица `SalesScript`, REST `/admin/scripts`, поля `salesScriptsPath` / `salesScriptSlug` в типах и JSON сборок, файлы `scripts/**/sales-scripts.json`. `ConfigManagementService.resolveDialogResourceBundle` возвращает только `bot` + `profile`. `DialogService`: `composeSnapshot(profile, bot)`, встроенные шаблоны при отключённом LLM; основной поток не пишет `handoff_events`. Миграция `20260428120000_remove_sales_script`. Документация обновлена.
- 2026-04-24: Админ-панель backend: `AdminModule` (CRUD `/admin/configurations`, `/admin/prompt-profiles`, `/admin/scripts`; `POST /admin/test-dialog`), `AuthModule` (JWT access/refresh, `AdminUser`, роли), `ConfigManagementModule` (разрешение бандла БД → файлы, опциональный кэш). Prisma: `AdminUser`, `Tenant`, `BotConfiguration`, `PromptProfile`, `SalesScript`; миграция `20260424120000_admin_and_config_management`. `DialogService`: `DialogRuntimeSnapshot`, `defaultSnapshot` для прод, `runDiagnosticTurn` для диагностики. `PromptProfileService`: `resolveFromPromptProfileJson`, `resolveProfileFromFilesystem`; в типах профиля — `scopeText`. `.env.example`: переменные JWT. После pull — `npx prisma migrate deploy`. *(Часть этого пункта отменена записью 2026-04-28: `SalesScript` и `/admin/scripts` удалены; REST-админка и `AuthModule` — записью 2026-05-05.)*
- 2026-04-18: RAG (`RagModule`/`RagService`, `useRag` в конфиге бота); `DialogModule` импортирует `RagModule`. Режим консультанта по базе знаний: `strictKnowledgeMode`, разговорный обход без ложных отказов — паттерны в профиле или дефолты в `strict-knowledge-conversational.defaults.ts` (без `\b` для кириллицы; при обходе retrieval не вызывается). Смягчены тексты `noKnowledgeReply` / системного промпта при отсутствии фрагментов. Prisma: retry подключения к БД при старте; `npm run db:up` / `db:down`.
- 2026-04-14: Добавлен «свободный режим» (`openTopicsMode`) для диалога на любые темы: `config/prompt-profiles/open-topics.json`, `config/configurations/open-topics.json`; обновлены `PromptProfileService`/типы и сборка системного промпта в `DialogService` (в open-topics без «рамки темы» и без блока sales-правил). *(Отдельный JSON sales-scripts для open-topics позже убран — см. 2026-04-28.)*
- 2026-04-14: **Очередь входящих (BullMQ) в продакшен-пути**: `dialog-inbound`, `processInboundQueued`, `IdempotencyService.revert` при сбое enqueue; `jobId` без `:` (`telegram-…`, `whatsapp-…`); экспорт `TelegramService` / `WhatsAppService`; `GET /health/queue`; dev-логи очереди; `HealthModule` → `DialogQueueModule`. Docker Compose: убраны `version` и жёсткие `container_name`. Параметры в `.env.example`. (Запись от 2026-04-09 про «Redis без воркера» устарела.)
- 2026-04-14: Удалены таблица и модель Prisma `LeadState` (фактически дублировали последнее сообщение клиента; поля бюджета/сроков не использовались). Добавлена миграция `20260414120000_drop_lead_state`; убран `upsert` из `DialogService`. После pull — `npx prisma migrate deploy` (или `migrate dev`).
- 2026-04-14: В блоке `handoff` JSON sales-скриптов ключ триггеров переименован: `rules` → `handOffTriggers`. *(Целиком JSON sales-scripts и handoff из основного потока удалены 2026-04-28.)*
- 2026-04-13: Конфигурации бота (`BOT_CONFIGURATION`, `config/configurations/*.json`); расширенные поля профиля промпта и `humanLikeMode`; тестовые профили `test-saas` / `test-fitness` и сборка `daria-mokko`; обновлены `docs/README.md`.
- 2026-04-09: План развития планировался в `docs/ROADMAP.md` (файл в текущем дереве репозитория отсутствует).
- 2026-04-09: Уточнён статус Redis/BullMQ (инфра + зависимости; воркер в коде подключён позже — см. Change Log 2026-04-14); добавлен черновик «План развития»; обновлён Next п.1; стадия проекта в шапке.
- 2026-04-09: Добавлен черновик `docs/BOT_ALGORITHM.md` (позже файл убран из репозитория; см. `docs/README.md`).
- 2026-04-09: Учтены `LLM_CONTEXT_MESSAGES` и `LLM_TIMEOUT_MS` в `DialogService` / `LlmService`; в README — подсказки по ускорению LLM.
- 2026-04-09: Логи обработки входящих сообщений Telegram/WhatsApp (этапы и тайминги) включены только в dev (`NODE_ENV=development`).
- 2026-04-09: Рамка промпта вынесена из `.env` в сменные профили `config/prompt-profiles/*.json`, модуль `PromptProfileModule`, выбор `LLM_PROMPT_PROFILE`.
- 2026-04-08: Добавлен `README.md` с инструкцией по запуску (Docker, Prisma, ngrok, Telegram/WhatsApp).
- 2026-04-07: Инициализированы `PROMPT_PLAN.md` и `DEVELOPMENT_CONTEXT.md`.
- 2026-04-07: Зафиксирован целевой стек в черновике `TECH_STACK.md` и обновлён roadmap (файлы позже могли быть перенесены или удалены из репозитория).
- 2026-04-08: Создан MVP-каркас приложения (NestJS, Docker Compose, Prisma schema, health endpoint).
- 2026-04-08: Подключен базовый WhatsApp webhook модуль и отправка текстовых ответов.
- 2026-04-08: Подключен базовый Telegram webhook модуль и отправка текстовых ответов.
- 2026-04-08: Добавлены `telegram:webhook:*` команды и загрузка `.env` в рантайме.
- 2026-04-08: Реализован общий `DialogService` и запись входящих/исходящих сообщений в БД (Prisma).
- 2026-04-08: Выполнен `prisma migrate dev --name init`, создана и применена первая миграция.
- 2026-04-08: `DialogService` использовал внешний конфиг `scripts/sales-scripts.json` (тексты и правила). *(Заменено встроенными шаблонами; JSON удалён — 2026-04-28.)*
- 2026-04-08: Реализован handoff (конфиг-триггеры, статус `HANDED_OFF`, запись в `handoff_events`). *(Запись handoff из основного потока отключена с 2026-04-28.)*
- 2026-04-08: Добавлены idempotency (messageId) и валидация подписи WhatsApp webhook; применена миграция `add_idempotency`.
- 2026-04-08: Добавлен `LlmService` (API) и генерация ответов в `DialogService` с fallback на шаблоны (тогда — JSON sales-scripts; с 2026-04-28 — встроенные строки в коде).
- 2026-04-08: Расширен системный промпт (тема, запреты, файл scope) и опциональный `LLM_MAX_TOKENS`.
