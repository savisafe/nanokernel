import { AsyncLocalStorage } from "node:async_hooks";
import type { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";

interface TelegramBotContext {
  bot: ResolvedBotConfiguration;
}

/**
 * Per-request bot context для Telegram. Используется в `sendMessage`, `getFile`,
 * `answerCallbackQuery` и т.п. — чтобы не пробрасывать `bot` через 20+ сайтов.
 *
 * Контекст устанавливается на двух entry-point'ах:
 * - `TelegramService.handleIncoming(payload, bot)` — синхронный путь вебхука
 * - `TelegramService.processInboundQueued(data, bot)` — путь воркера BullMQ
 *
 * AsyncLocalStorage прозрачно проходит через async/await, setTimeout, Promise chains.
 */
export const telegramBotAls = new AsyncLocalStorage<TelegramBotContext>();

/** Возвращает текущий bot из контекста; undefined если за пределами known entry-point. */
export function currentTelegramBot(): ResolvedBotConfiguration | undefined {
  return telegramBotAls.getStore()?.bot;
}

/**
 * Разрешает Telegram-токен для текущего вебхука:
 * 1. Per-bot token из bot.channel.telegram.tokenEnv (если задан)
 * 2. Fallback на env TELEGRAM_BOT_TOKEN (для legacy сборок без channel-блока)
 */
export function resolveTelegramToken(): string | undefined {
  const bot = currentTelegramBot();
  const tokenEnv = bot?.channel?.telegram?.tokenEnv;
  if (tokenEnv) {
    const v = process.env[tokenEnv];
    if (v && v.trim().length > 0) {
      return v;
    }
    // Намеренно проваливаемся в env-fallback при пустом tokenEnv —
    // позволяет тестам/локалкам работать без переменной до конфигурации.
  }
  return process.env.TELEGRAM_BOT_TOKEN;
}
