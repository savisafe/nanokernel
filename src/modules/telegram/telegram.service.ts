import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import { DialogQueueService } from "../dialog-queue/dialog-queue.service";
import { DialogService } from "../dialog/dialog.service";
import { DialogOutput } from "../dialog/dialog.types";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { isDevelopment } from "../shared/is-development";
import type { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import { telegramBotAls, resolveTelegramToken } from "./telegram-bot-context";
import {
  type TelegramApiMessage,
  type TelegramUnsupportedAttachment,
  IncomingTelegramMessage,
  TelegramWebhookPayload,
} from "./telegram.types";

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  /** Сериализация обработки входящих по chatId (защита от reorder при параллельных вебхуках). */
  private readonly inboundChains = new Map<number, Promise<void>>();

  constructor(
    private readonly dialogService: DialogService,
    private readonly idempotencyService: IdempotencyService,
    @Inject(forwardRef(() => DialogQueueService))
    private readonly dialogQueueService: DialogQueueService,
  ) {}

  private static messageFromUpdate(payload: TelegramWebhookPayload): TelegramApiMessage | undefined {
    return payload.message ?? payload.channel_post ?? payload.edited_message;
  }

  private static detectUnsupportedAttachment(
    msg: TelegramApiMessage,
  ): TelegramUnsupportedAttachment | undefined {
    if (msg.photo && msg.photo.length > 0) return "photo";
    if (msg.voice?.file_id) return "voice";
    if (msg.audio?.file_id) return "audio";
    if (msg.video?.file_id) return "video";
    if (msg.video_note?.file_id) return "video_note";
    if (msg.sticker?.file_id) return "sticker";
    return undefined;
  }

  /**
   * Извлекает text-сообщение из Telegram update. Документы/медиа теперь
   * не обрабатываются: для медиа возвращается unsupportedAttachment, для
   * документов — игнорируется (нет use-case в платформе ядра v9+).
   */
  extractMessage(payload: TelegramWebhookPayload): IncomingTelegramMessage | null {
    const message = TelegramService.messageFromUpdate(payload);
    if (!message) return null;
    const chatId = message.chat?.id;
    if (typeof chatId !== "number") return null;

    const combinedText = (message.text ?? message.caption ?? "").trim();
    if (combinedText) {
      return { chatId, text: combinedText, messageId: message.message_id };
    }

    const unsupported = TelegramService.detectUnsupportedAttachment(message);
    if (unsupported) {
      return {
        chatId,
        text: "",
        messageId: message.message_id,
        unsupportedAttachment: unsupported,
      };
    }
    return null;
  }

  private logSkippedTelegramUpdate(payload: TelegramWebhookPayload): void {
    const msg = TelegramService.messageFromUpdate(payload);
    const payloadKeys = Object.keys(payload).join(",");
    const msgKeys = msg ? Object.keys(msg).join(",") : "";
    this.logger.warn(
      `Telegram update ignored (no text we handle): update_id=${payload.update_id ?? "?"} payloadKeys=${payloadKeys} messageKeys=${msgKeys}`,
    );
  }

  async handleIncoming(
    payload: TelegramWebhookPayload,
    bot: ResolvedBotConfiguration,
  ): Promise<void> {
    return telegramBotAls.run({ bot }, () => this.handleIncomingInContext(payload, bot));
  }

  private async handleIncomingInContext(
    payload: TelegramWebhookPayload,
    bot: ResolvedBotConfiguration,
  ): Promise<void> {
    if (payload.callback_query) {
      // Callback-кнопки в v2 не используются ядром. Если бизнес-сценарию они нужны,
      // обработчики строятся поверх контракта Skill, а не вшиты в канал.
      return;
    }

    const message = this.extractMessage(payload);
    if (!message) {
      this.logSkippedTelegramUpdate(payload);
      return;
    }

    const shouldProcess = await this.idempotencyService.tryProcess(
      "telegram",
      String(message.chatId),
      message.messageId?.toString(),
    );
    if (!shouldProcess) {
      this.logger.warn(`Duplicate Telegram message skipped: ${message.messageId ?? "unknown"}`);
      return;
    }

    if (message.unsupportedAttachment) {
      // Медиа без текста: молча игнорируем. Можно поднять отдельный snippet
      // через бот-конфигурацию, если нужен явный ответ "не поддерживаю".
      if (isDevelopment()) {
        this.logger.log(
          `[Telegram] ignored unsupported attachment chatId=${message.chatId} type=${message.unsupportedAttachment}`,
        );
      }
      return;
    }

    const dev = isDevelopment();
    const preview =
      message.text.length > 120 ? `${message.text.slice(0, 120)}…` : message.text;
    const flowStarted = dev ? performance.now() : 0;
    if (dev) {
      this.logger.log(
        `[Telegram] 1/3 received bot=${bot.id} chatId=${message.chatId} messageId=${message.messageId ?? "n/a"}: ${preview}`,
      );
    }

    if (this.dialogQueueService.isEnabled()) {
      try {
        await this.dialogQueueService.enqueue({
          channel: "telegram",
          botId: bot.id,
          ...message,
        });
      } catch (e) {
        await this.idempotencyService.revert(
          "telegram",
          String(message.chatId),
          message.messageId?.toString(),
        );
        throw e;
      }
      if (dev) {
        this.logger.log(
          `[Telegram] enqueued bot=${bot.id} chatId=${message.chatId} messageId=${message.messageId ?? "n/a"} (${Math.round(performance.now() - flowStarted)}ms to ack path)`,
        );
      }
      return;
    }

    await this.processInboundQueued(message, bot, flowStarted);
  }

  /** Тяжёлая обработка: LLM + отправка ответа (вебхук или воркер очереди). */
  async processInboundQueued(
    message: IncomingTelegramMessage,
    bot: ResolvedBotConfiguration,
    flowStarted?: number,
  ): Promise<void> {
    await telegramBotAls.run({ bot }, () =>
      this.runInboundSerialized(message.chatId, () =>
        this.processInboundQueuedInner(message, flowStarted),
      ),
    );
  }

  private runInboundSerialized(chatId: number, task: () => Promise<void>): Promise<void> {
    const prev = this.inboundChains.get(chatId) ?? Promise.resolve();
    const composed = prev.catch(() => undefined).then(() => task());
    this.inboundChains.set(chatId, composed);
    composed.finally(() => {
      if (this.inboundChains.get(chatId) === composed) {
        this.inboundChains.delete(chatId);
      }
    });
    return composed;
  }

  private async processInboundQueuedInner(
    message: IncomingTelegramMessage,
    flowStarted?: number,
  ): Promise<void> {
    const dev = isDevelopment();
    const flowT0 = flowStarted ?? (dev ? performance.now() : 0);
    const dialogStarted = dev ? performance.now() : 0;
    const stopTyping = this.startTypingIndicator(message.chatId);

    // Streaming UX: первая дельта LLM → placeholder-сообщение, далее throttled
    // editMessageText каждые ≥500ms. Если LLM-вызова нет (snippet/FSM/safety hit)
    // — placeholderId остаётся null и финальный текст уходит обычным sendMessage.
    let placeholderId: number | null = null;
    let lastEditAt = 0;
    let lastShown = "";
    const MIN_EDIT_INTERVAL_MS = 500;
    const MAX_DISPLAY_CHARS = 4000;
    const onLlmTextDelta = async (text: string): Promise<void> => {
      if (!text) return;
      const sliced = text.length > MAX_DISPLAY_CHARS ? text.slice(0, MAX_DISPLAY_CHARS) : text;
      const now = Date.now();
      if (placeholderId === null) {
        placeholderId = await this.sendMessage(message.chatId, sliced);
        lastShown = sliced;
        lastEditAt = now;
        return;
      }
      if (now - lastEditAt < MIN_EDIT_INTERVAL_MS) return;
      if (sliced === lastShown) return;
      lastEditAt = now;
      lastShown = sliced;
      await this.editMessageText(message.chatId, placeholderId, sliced);
    };

    let result: DialogOutput;
    try {
      result = await this.dialogService.process(
        {
          channel: "telegram",
          externalUserId: String(message.chatId),
          text: message.text,
        },
        { onLlmTextDelta },
      );
    } finally {
      stopTyping();
    }
    if (dev) {
      const dialogMs = Math.round(performance.now() - dialogStarted);
      this.logger.log(
        `[Telegram] 2/3 dialog done chatId=${message.chatId} stage=${result.stage} in ${dialogMs}ms`,
      );
    }

    const sendStarted = dev ? performance.now() : 0;
    const finalText = result.replyText;
    const sliced =
      finalText.length > MAX_DISPLAY_CHARS ? finalText.slice(0, MAX_DISPLAY_CHARS) : finalText;
    let sent: boolean;
    if (placeholderId !== null) {
      if (sliced !== lastShown) {
        sent = await this.editMessageText(message.chatId, placeholderId, sliced);
      } else {
        sent = true;
      }
    } else {
      const id = await this.sendMessage(message.chatId, finalText);
      sent = id !== null;
    }
    if (dev) {
      const sendMs = Math.round(performance.now() - sendStarted);
      const totalMs = Math.round(performance.now() - flowT0);
      const mode = placeholderId !== null ? "stream-edit" : "send";
      this.logger.log(
        `[Telegram] 3/3 ${sent ? "reply sent" : "reply NOT sent (see errors above)"} chatId=${message.chatId} via=${mode} in ${sendMs}ms | total ${totalMs}ms (webhook → user sees message)`,
      );
    }
  }

  /**
   * Возвращает message_id отправленного сообщения (для editMessageText), либо null
   * при ошибке. Большинство callers игнорят результат — это нормально, falsy
   * (null/0) при ошибке всё ещё ведёт себя как старый boolean false.
   */
  async sendMessage(
    chatId: number,
    text: string,
    options?: { replyMarkup?: Record<string, unknown> },
  ): Promise<number | null> {
    const token = resolveTelegramToken();
    if (!token) {
      this.logger.warn(
        "Telegram token not resolved (channel.telegram.tokenEnv or TELEGRAM_BOT_TOKEN)",
      );
      return null;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (options?.replyMarkup) {
      body.reply_markup = options.replyMarkup;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      this.logger.error(`Telegram send failed: ${response.status} ${errText}`);
      return null;
    }
    try {
      const json = (await response.json()) as { result?: { message_id?: number } };
      const id = json.result?.message_id;
      return typeof id === "number" ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * editMessageText — для streaming-обновления placeholder-сообщения.
   * Возвращает true при успехе. Игнорирует "message is not modified" ошибки
   * (нормально для no-op edit при дребезге throttle'а).
   */
  async editMessageText(chatId: number, messageId: number, text: string): Promise<boolean> {
    const token = resolveTelegramToken();
    if (!token) return false;
    const url = `https://api.telegram.org/bot${token}/editMessageText`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
      });
      if (!response.ok) {
        const errText = await response.text();
        if (errText.includes("message is not modified")) {
          return true;
        }
        this.logger.verbose(`Telegram editMessageText failed: ${response.status} ${errText}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.verbose(
        `Telegram editMessageText error: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  private startTypingIndicator(chatId: number): () => void {
    void this.sendChatAction(chatId, "typing");
    const intervalMs = 4000;
    const timer = setInterval(() => {
      void this.sendChatAction(chatId, "typing");
    }, intervalMs);
    return () => clearInterval(timer);
  }

  private async sendChatAction(chatId: number, action: string): Promise<void> {
    const token = resolveTelegramToken();
    if (!token) return;
    const url = `https://api.telegram.org/bot${token}/sendChatAction`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action }),
      });
      if (!response.ok) {
        const errText = await response.text();
        this.logger.verbose(`Telegram sendChatAction failed: ${response.status} ${errText}`);
      }
    } catch (e) {
      this.logger.verbose(
        `Telegram sendChatAction error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
