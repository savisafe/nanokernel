# AI Manager

Backend для AI-менеджера в чатах: **Telegram** и **WhatsApp** (webhook), общая диалоговая логика (`DialogService`), сохранение истории в **PostgreSQL**, опционально **локальная LLM** через провайдер с OpenAI-совместимым API (**LM Studio** и т.п.). Если LLM выключена или недоступна, используются короткие встроенные текстовые шаблоны в коде (не отдельные JSON-файлы).

Текущий статус разработки: [DEVELOPMENT_CONTEXT.md](DEVELOPMENT_CONTEXT.md).

---

## Требования

- **Node.js** 20+ (LTS)
- **Docker** и **Docker Compose** (для PostgreSQL)
- **ngrok** (или другой HTTPS-туннель) — для Telegram/WhatsApp webhook с локальной машины
- **LM Studio** (локальный сервер с `…/v1/chat/completions`) — если включена генерация через LLM (`LLM_ENABLED=true`)

---

## Быстрый старт

### 1. Клонирование и зависимости

```bash
cd ai-bot
npm install
```

### 2. Переменные окружения

Скопируй пример и отредактируй:

```bash
cp .env.example .env
```

Файл `.env` в git не коммитится (см. `.gitignore`). Все секреты только там.

### 3. PostgreSQL

Поднять контейнер:

```bash
docker compose up -d postgres
```

По умолчанию в `.env.example` указан URL:

`postgresql://postgres:postgres@localhost:5432/ai_manager?schema=public`

### 4. Миграции Prisma

```bash
npm run prisma:migrate
```

При первом запуске создастся схема БД. Для просмотра данных: `npm run prisma:studio`.

### 5. Сборка и запуск

Разработка (hot-подобный режим через `ts-node`):

```bash
npm run start:dev
```

Продакшен-сборка:

```bash
npm run build
npm start
```

API по умолчанию: **http://localhost:3000** (порт задаётся `PORT`).

### 6. Проверка, что сервер жив

```bash
curl -s http://localhost:3000/health
```

Ожидается JSON со статусом `ok`.

---

## Telegram + ngrok (локальная разработка)

Telegram шлёт webhook только на **публичный HTTPS**. Для работы с `localhost` нужен туннель.

### Установка ngrok (macOS, Homebrew)

```bash
brew install ngrok/ngrok/ngrok
```

Рекомендуется один раз привязать аккаунт (токен из [dashboard ngrok](https://dashboard.ngrok.com)):

```bash
ngrok config add-authtoken <YOUR_NGROK_AUTHTOKEN>
```

### Запуск туннеля

В одном терминале — API бота:

```bash
npm run start:dev
```

В другом — туннель на порт приложения (по умолчанию 3000):

```bash
ngrok http 3000
```

В выводе ngrok возьми HTTPS-URL, например: `https://abc123.ngrok-free.app`.

### Настройка `.env` для Telegram

Обязательно укажи **полный путь** до webhook-эндпоинта:

```env
TELEGRAM_BOT_TOKEN=<токен от @BotFather>
TELEGRAM_WEBHOOK_URL=https://abc123.ngrok-free.app/webhooks/telegram
```

Важно: URL должен заканчиваться на **`/webhooks/telegram`**, иначе Telegram получит `404` и бот не ответит.

### Регистрация webhook у Telegram

Из корня проекта:

```bash
npm run telegram:webhook:set
npm run telegram:webhook:info
```

В `telegram:webhook:info` проверь:

- в `result.url` указан именно `https://.../webhooks/telegram`;
- нет `last_error_message` (или после исправления URL ошибка пропала).

Полезные команды:

```bash
npm run telegram:webhook:delete   # сбросить webhook
```

### Проверка без Telegram

```bash
curl -s https://<твой-ngrok>/webhooks/telegram/health
```

Ожидается JSON с `"channel":"telegram"`.

---

## WhatsApp (Meta Cloud API / совместимые провайдеры)

1. В кабинете Meta (или у BSP) настрой webhook:
   - **Callback URL**: `https://<твой-домен-или-ngrok>/webhooks/whatsapp`
   - **Verify token**: то же значение, что в `WHATSAPP_VERIFY_TOKEN`

2. В `.env`:

```env
WHATSAPP_VERIFY_TOKEN=<секрет для verify>
WHATSAPP_ACCESS_TOKEN=<токен отправки сообщений>
WHATSAPP_PHONE_NUMBER_ID=<id номера>
WHATSAPP_APP_SECRET=<App Secret из настроек приложения Meta>
```

Подпись входящих запросов: заголовок `X-Hub-Signature-256`. Если `WHATSAPP_APP_SECRET` не задан, в dev подпись **не проверяется** (в лог пишется предупреждение).

Для локальной отладки снова используй **ngrok** с HTTPS-URL на тот же порт, что и API.

---

## Локальная LLM (LM Studio)

`LlmService` ходит в **`POST {LLM_BASE_URL}/chat/completions`** (OpenAI-совместимый путь). Имя модели **не задаётся в `.env`**: при старте первого запроса выполняется **`GET {LLM_BASE_URL}/models`**, берётся **первая запись в `data[]`, у которой `id` не похож на embedding** (строка `embed` в id пропускается — чтобы не выбрать `text-embedding-…` рядом с чат-моделью). Заголовок запросов: `Authorization: Bearer local` (для локальных серверов достаточно фиктивного значения).

1. Установка локальной модели

2. Проверка, что модель видна:

```bash
curl -s http://127.0.0.1:11434/api/tags
```

Список не должен быть пустым.

3. В `.env` укажи базовый URL API:

```env
LLM_ENABLED=true
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_TEMPERATURE=0.35
LLM_MAX_TOKENS=2048
```

### LM Studio

1. В LM Studio включи **Local Server** (например порт **1234**).
2. Загрузи чат-модель в память (Developer → Load); иначе провайдер вернёт ошибку вида «No models loaded».
3. В `.env`:

```env
LLM_ENABLED=true
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_TEMPERATURE=0.35
LLM_MAX_TOKENS=2048
```

Убедись, что **`GET {LLM_BASE_URL}/models`** возвращает нужную чат-модель **раньше** embedding-моделей (или что embedding имеет `embed` в id — тогда она будет пропущена при выборе).

### Лимит токенов и модели с «reasoning»

У части моделей (например **Gemma 4** в LM Studio) ответ разбивается на скрытое **`reasoning_content`** и видимое **`content`**. Если **`LLM_MAX_TOKENS`** слишком мал, весь лимит уходит в reasoning, **`content` остаётся пустым**, `finish_reason` становится **`length`** — бэкенд не подставляет reasoning в чат пользователю и уходит во **встроенные шаблоны**. В `.env.example` задан разумный пример (**2048**); если переменная **не задана**, в коде используется то же значение по умолчанию. При необходимости увеличь лимит или уменьши «thinking» в настройках провайдера.

### Сборка бота

Какая ниша и какие файлы подключать — переменная **`BOT_CONFIGURATION`** и JSON [config/configurations/](../config/configurations/):

- В `.env`: `BOT_CONFIGURATION=daria-mokko` (или `default`, `test-saas`, `test-fitness` и т.д.).
- Файл `config/configurations/<имя>.json` задаёт **`llmPromptProfile`** (имя без `.json` из каталога профилей) и опционально **`useRag`** (векторный поиск по базе знаний вместо лексического).
- После смены значения нужен **перезапуск** приложения.

### Профиль промпта

Рамка темы, компания, persona, цели, запреты, `humanLikeMode`, опционально `scopeFile` — JSON в [config/prompt-profiles/](../config/prompt-profiles/):

- Идентификатор профиля берётся из **`llmPromptProfile`** в активной сборке; если там не задан — используется fallback **`LLM_PROMPT_PROFILE`** (например `default` → `config/prompt-profiles/default.json`).
- Новый бренд: добавь `config/prompt-profiles/my-brand.json`, затем создай или скопируй `config/configurations/my-brand.json` с `"llmPromptProfile": "my-brand"` (и при необходимости `"useRag": true`).
- Длинные факты о продукте: поле `"scopeFile": "config/llm-scope.txt"` в JSON профиля; шаблон: [config/llm-scope.example.txt](../config/llm-scope.example.txt).

Пример профиля без scope: `config/prompt-profiles/minimal.json`.

Если `LLM_ENABLED=false` или провайдер LLM недоступен, ответы идут из **встроенных шаблонов** в `DialogService` (короткие фразы для стадий `contact` / `qualification` в зависимости от `conversation.stage` в БД).

---

## Полезные npm-скрипты

| Команда | Назначение |
|--------|------------|
| `npm run start:dev` | Запуск в режиме разработки |
| `npm run build` | Сборка TypeScript |
| `npm start` | Запуск собранного `dist/main.js` |
| `npm run prisma:migrate` | Миграции БД |
| `npm run prisma:generate` | Генерация Prisma Client |
| `npm run prisma:studio` | UI для данных в БД |
| `npm run telegram:webhook:set` | Установить Telegram webhook из `TELEGRAM_WEBHOOK_URL` |
| `npm run telegram:webhook:info` | Текущий webhook и ошибки доставки |
| `npm run telegram:webhook:delete` | Удалить webhook |

---

## Структура эндпоинтов (кратко)

| Метод | Путь | Назначение |
|--------|------|------------|
| GET | `/health` | Healthcheck |
| GET | `/webhooks/telegram/health` | Проверка канала Telegram через туннель |
| POST | `/webhooks/telegram` | Входящие обновления Telegram |
| GET | `/webhooks/whatsapp` | Верификация webhook (challenge) |
| POST | `/webhooks/whatsapp` | Входящие события WhatsApp |

---

## Типичные проблемы

| Симптом | Что проверить |
|--------|----------------|
| Telegram не отвечает | `TELEGRAM_WEBHOOK_URL` заканчивается на `/webhooks/telegram`; `npm run telegram:webhook:set`; ngrok и `npm run start:dev` запущены |
| `404` в `last_error_message` у Telegram | В webhook указан только корень ngrok без пути `/webhooks/telegram` |
| Сменился URL ngrok | Обновить `TELEGRAM_WEBHOOK_URL` и снова `npm run telegram:webhook:set` |
| LM Studio: «No models loaded» | Загрузить модель в Developer / `lms load`; дождаться Ready |
| Ответы «шаблонные», не LLM | `LLM_ENABLED=true`, с машины с Node доступен `LLM_BASE_URL` (тот же хост/порт, что у сервера LLM); `GET …/models` не пустой; для reasoning-моделей — достаточно большой `LLM_MAX_TOKENS` (см. раздел выше) |
| Пустой ответ LLM, в логах провайдера пустой `content`, полный `reasoning_content`, `finish_reason: length` | Увеличить `LLM_MAX_TOKENS` (например 2048+) или снизить объём reasoning в LM Studio |
| Долгий этап `2/3 dialog` (десятки секунд) | Локальный инференс: меньшая/быстрее квантованная модель, GPU/Metal, меньше `LLM_MAX_TOKENS`, меньше `LLM_CONTEXT_MESSAGES`, короче системный промпт/`scopeFile`; облачный API быстрее CPU |
| Ошибки БД | `docker compose up -d postgres`, корректный `DATABASE_URL`, выполнены миграции |

---

## Redis

В `docker-compose.yml` есть сервис **redis**; для текущего MVP очередь BullMQ может быть ещё не подключена к обработке webhook. При необходимости подними Redis:

```bash
docker compose up -d redis
```

---

## Документы проекта

- [DEVELOPMENT_CONTEXT.md](DEVELOPMENT_CONTEXT.md) — что сделано и что дальше

**Поток одного входящего сообщения (упрощённо):** вебхук Telegram/WhatsApp → (опционально) постановка job в **BullMQ** → `DialogService`: запись сообщения в БД → контекст из истории + профиль промпта → вызов LLM или встроенный шаблон → запись ответа и отправка в канал. Сборка бота и профиль читаются из `BOT_CONFIGURATION` и `config/` на диске; админка может тестировать другую конфигурацию через `POST /admin/test-dialog` и `ConfigManagementService` (без отдельного слоя sales-scripts).
