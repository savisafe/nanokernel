# Как связать бота с Mesto (web)

Пошаговая инструкция: подключить ai-bot к CRM Mesto, чтобы бот читал реальное
расписание и создавал/переносил/отменял записи.

> **Модель связи.** Бот — HTTP-клиент, Mesto (web) — сервер внешнего API
> (`/api/external/*`). Вся «связь» = **URL веба** + **API-ключ бизнеса**
> (один ключ = один бизнес). Контракт API: `mesto-web/docs/api/bot-integration.md`.

## Что с чем стыкуется

| Сторона Mesto (web) | → | Сторона бота |
|---|---|---|
| URL, где живёт `/api/external/*` | → | `config/businesses/<id>/configuration.json` → `crm.baseUrl` |
| ключ из `/settings/api` (`mst_live_…`) | → | env-переменная (имя — в `crm.apiKeyEnv`, напр. `DARIA_MOKKO_MESTO_KEY`) |
| услуга `external_id` | ↔ | `id` услуги в `config/businesses/<id>/data/services.json` |
| `businesses.timezone` | — | зону знает Mesto; бот шлёт слоты как есть |

---

## Шаг 1. Подготовить бизнес в Mesto (web)

Без этих данных интеграция «пустая» (availability вернёт closed, матч услуг не сработает).

1. Залогиниться в Mesto, выбрать нужный бизнес.
2. **`/schedule`** — задать рабочие часы по дням недели (+ блоки: обед/выходной).
   Без графика бот не увидит свободных окон.
3. **Услуги** — у услуг проставить `external_id`, совпадающие с `id` услуг в боте
   (`config/businesses/<id>/data/services.json`). Точный матч надёжнее; если id не
   совпадут — Mesto матчит по названию услуги.
4. Убедиться, что бизнес активен (`is_active = true`) и не в архиве.

## Шаг 2. Создать API-ключ (web)

1. **`/settings/api`** → «Создать ключ» → задать имя (напр. «tg-bot»).
2. Скопировать `mst_live_…` — **ключ показывается один раз**.

## Шаг 3. Прописать ключ и URL в боте

1. **Env** — положить ключ в переменную, имя которой указано в `crm.apiKeyEnv`:
   ```bash
   # .env бота
   DARIA_MOKKO_MESTO_KEY=mst_live_…
   ```
2. **`configuration.json`** бизнеса — блок `crm`:
   ```jsonc
   "crm": {
     "provider": "mesto",
     "baseUrl": "http://localhost:3000",   // прод: домен веба, напр. https://mesto.pro
     "apiKeyEnv": "DARIA_MOKKO_MESTO_KEY"
   }
   ```
   `baseUrl` указывает на **веб** (где `/api/external/*`), без хвостового слеша.

## Шаг 4. Миграция БД бота

Sync-колонки `Booking` (`mestoAppointmentId`, `syncStatus`, …) требуют миграции:
```bash
npm run db:up           # поднять Postgres+Redis бота (docker)
npm run prisma:migrate  # применить миграции (создаст sync-колонки)
```

## Шаг 5. Запустить

> **Порты.** И веб, и бот по умолчанию слушают `3000`. Локально разведите:
> веб — `3000`, боту задайте другой `PORT` (напр. `PORT=3100`). `crm.baseUrl`
> бота при этом указывает на **веб** (`3000`), не на себя.

```bash
# веб (отдельный терминал, в mesto-web)
npm run start:dev                 # http://localhost:3000

# бот (в mesto-bot)
PORT=3100 npm run start:dev
```

Telegram-вебхук (чтобы сообщения доходили до бота):
```bash
npm run telegram:webhook:set      # регистрирует POST {TELEGRAM_WEBHOOK_BASE_URL}/webhooks/telegram/<secret>
```
- Токен бота — в env, имя из `channel.telegram.tokenEnv` (напр. `SALON_ADMIN_TG_TOKEN`).
- Для **локального** теста Telegram'у нужен публичный URL — поднимите туннель
  (ngrok/cloudflared) и укажите его в `TELEGRAM_WEBHOOK_BASE_URL`.

---

## Проверка связи

**Быстро, без Telegram** — curl по `crm.baseUrl` с тем же ключом, что в боте:
```bash
curl -s -H "Authorization: Bearer $DARIA_MOKKO_MESTO_KEY" \
  "http://localhost:3000/api/external/availability?from=2026-06-02&to=2026-06-08" | jq
```
Если вернулись окна — связка «ключ + URL» рабочая.

**Полный путь** — написать боту в Telegram «хочу записаться на коррекцию завтра»:
бот вызовет `check_availability` (реальные окна Mesto) → после подтверждения
`book_slot` создаст запись → она появится в **`/calendar`** студии (`source=external`).

Что полезно проверить руками:
- запись на **закрытую дату/в блок** → бот скажет «время недоступно» (Mesto вернул `422`);
- **отмена/перенос** — «отмените мою запись» / «перенесите на субботу»;
- повтор — дубля не будет (идемпотентность по `idempotency_key`).

---

## Прод

То же самое, плюс:
- `crm.baseUrl` = боевой URL веба (напр. Vercel-домен);
- ключ — в прод-env бота (не в репозитории);
- веб должен быть **доступен из сети** бота;
- `TELEGRAM_WEBHOOK_BASE_URL` = публичный домен бота.

---

## Типичные ошибки

| Симптом | Причина / решение |
|---|---|
| `401 UNAUTHORIZED` | Ключ неверный/не тот env. Сверь `crm.apiKeyEnv` ↔ имя переменной ↔ значение из `/settings/api`. |
| `relation "api_keys" does not exist` (на вебе) | На БД веба не применены миграции — `npm run db:migrate` в `mesto-web`. |
| День всегда `closed` / «нет окон» | Не задан рабочий график бизнеса — заполни `/schedule`. |
| `422 OUT_OF_HOURS` / `BLOCKED` при ожидаемо рабочем времени | Время вне часов или попадает в блок; проверь `/schedule`. Учти зону бизнеса (`businesses.timezone`). |
| Бот пишет «расписание недоступно» | `crm` не настроен или `baseUrl` недостижим из бота. Проверь URL/сеть/порты. |
| `PrismaClientKnownRequestError` про `syncStatus`/`mestoAppointmentId` | Не применена миграция бота — `npm run prisma:migrate`. |
| Запись не появилась, но клиенту сказали «записали» | Fail-open при недоступности Mesto: запись в локальном `Booking` (`syncStatus=failed`) + алерт в служебный чат. Подними веб и синкни вручную. |

Контракт и детали полей — `mesto-web/docs/api/bot-integration.md`.
Что и как реализовано — `mesto-web/docs/integration-plan.md`.
