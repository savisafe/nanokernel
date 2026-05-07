import { forwardRef, Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import { DialogQueueService } from "../dialog-queue/dialog-queue.service";
import { DialogService } from "../dialog/dialog.service";
import { DialogOutput } from "../dialog/dialog.types";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { PrismaService } from "../prisma/prisma.service";
import { isDevelopment } from "../shared/is-development";
import {
  IncomingTelegramMessage,
  TelegramWebhookPayload,
} from "./telegram.types";

@Injectable()
export class TelegramService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly draftAckTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly dialogService: DialogService,
    private readonly idempotencyService: IdempotencyService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => DialogQueueService))
    private readonly dialogQueueService: DialogQueueService,
  ) {}

  /** Первый токен как команда: нижний регистр, без @BotName (группы). */
  private static telegramCommandToken(rawTrimmed: string): string {
    const first = rawTrimmed.split(/\s+/)[0] ?? "";
    const base = first.includes("@") ? (first.split("@")[0] ?? first) : first;
    return base.toLowerCase();
  }

  onModuleDestroy() {
    for (const t of this.draftAckTimers.values()) {
      clearTimeout(t);
    }
    this.draftAckTimers.clear();
  }

  private clearDebouncedDraftAck(chatId: number): void {
    const existing = this.draftAckTimers.get(chatId);
    if (existing) {
      clearTimeout(existing);
      this.draftAckTimers.delete(chatId);
    }
  }

  /** Одно подтверждение после серии быстрых сообщений (вставка большого документа). */
  private scheduleDebouncedDraftAck(chatId: number): void {
    const onboarding = this.dialogService.getTelegramKnowledgeOnboarding();
    this.clearDebouncedDraftAck(chatId);
    const timer = setTimeout(() => {
      this.draftAckTimers.delete(chatId);
      void this.sendDebouncedDraftAckIfStillAwaiting(chatId);
    }, onboarding.draftAckDebounceMs);
    this.draftAckTimers.set(chatId, timer);
  }

  private async sendDebouncedDraftAckIfStillAwaiting(chatId: number): Promise<void> {
    const externalId = String(chatId);
    const user = await this.prisma.user.findFirst({
      where: { channel: "telegram", externalId },
    });
    if (!user?.telegramKnowledgeAwaiting) {
      return;
    }
    await this.sendMessage(chatId, this.dialogService.getTelegramKnowledgeOnboarding().draftSavedAck);
  }

  extractMessage(payload: TelegramWebhookPayload): IncomingTelegramMessage | null {
    const message = payload.message;
    const text = message?.text?.trim();
    const chatId = message?.chat?.id;

    if (!text || typeof chatId !== "number") {
      return null;
    }

    return {
      chatId,
      text,
      messageId: message?.message_id,
    };
  }

  async handleIncoming(payload: TelegramWebhookPayload): Promise<void> {
    const message = this.extractMessage(payload);
    if (!message) {
      return;
    }

    const shouldProcess = await this.idempotencyService.tryProcess(
      "telegram",
      message.messageId?.toString(),
    );
    if (!shouldProcess) {
      this.logger.warn(`Duplicate Telegram message skipped: ${message.messageId ?? "unknown"}`);
      return;
    }

    const dev = isDevelopment();
    const preview =
      message.text.length > 120 ? `${message.text.slice(0, 120)}…` : message.text;
    const flowStarted = dev ? performance.now() : 0;
    if (dev) {
      this.logger.log(
        `[Telegram] 1/3 received chatId=${message.chatId} messageId=${message.messageId ?? "n/a"}: ${preview}`,
      );
    }

    if (this.dialogQueueService.isEnabled()) {
      try {
        await this.dialogQueueService.enqueue({
          channel: "telegram",
          ...message,
        });
      } catch (e) {
        await this.idempotencyService.revert("telegram", message.messageId?.toString());
        throw e;
      }
      if (dev) {
        this.logger.log(
          `[Telegram] enqueued chatId=${message.chatId} messageId=${message.messageId ?? "n/a"} (${Math.round(performance.now() - flowStarted)}ms to ack path)`,
        );
      }
      return;
    }

    await this.processInboundQueued(message, flowStarted);
  }

  /** Тяжёлая обработка: LLM + отправка ответа (вебхук или воркер очереди). */
  async processInboundQueued(
    message: IncomingTelegramMessage,
    flowStarted?: number,
  ): Promise<void> {
    const handledKnowledge = await this.tryHandleTelegramKnowledgeOnboarding(message);
    if (handledKnowledge) {
      return;
    }

    const dev = isDevelopment();
    const flowT0 = flowStarted ?? (dev ? performance.now() : 0);
    const dialogStarted = dev ? performance.now() : 0;
    const stopTyping = this.startTypingIndicator(message.chatId);
    let result: DialogOutput;
    try {
      result = await this.dialogService.process({
        channel: "telegram",
        externalUserId: String(message.chatId),
        text: message.text,
      });
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
    const sent = await this.sendMessage(message.chatId, result.replyText);
    if (dev) {
      const sendMs = Math.round(performance.now() - sendStarted);
      const totalMs = Math.round(performance.now() - flowT0);
      this.logger.log(
        `[Telegram] 3/3 ${sent ? "reply sent to bot" : "reply NOT sent (see errors above)"} chatId=${message.chatId} in ${sendMs}ms | total ${totalMs}ms (webhook → user sees message)`,
      );
    }
  }

  /**
   * /start — приветствие (без сброса базы).
   * /new — сброс черновика и режим ожидания текста до /done.
   * Не вызывает диалог/LLM.
   */
  private async tryHandleTelegramKnowledgeOnboarding(
    message: IncomingTelegramMessage,
  ): Promise<boolean> {
    const externalId = String(message.chatId);
    const raw = message.text.trim();
    const cmd = TelegramService.telegramCommandToken(raw);
    const onboarding = this.dialogService.getTelegramKnowledgeOnboarding();

    if (cmd === "/start") {
      await this.sendMessage(message.chatId, onboarding.welcomeStart);
      return true;
    }

    if (cmd === "/new") {
      this.clearDebouncedDraftAck(message.chatId);
      await this.prisma.user.upsert({
        where: {
          channel_externalId: { channel: "telegram", externalId },
        },
        create: {
          channel: "telegram",
          externalId,
          telegramKnowledgeAwaiting: true,
          knowledgeDraft: null,
          knowledgeScopeText: null,
        },
        update: {
          telegramKnowledgeAwaiting: true,
          knowledgeDraft: null,
          knowledgeScopeText: null,
        },
      });
      await this.sendMessage(message.chatId, onboarding.newDocHint);
      return true;
    }

    const user = await this.prisma.user.findFirst({
      where: { channel: "telegram", externalId },
    });
    if (!user?.telegramKnowledgeAwaiting) {
      return false;
    }

    if (cmd === "/done" || cmd === "/готово") {
      this.clearDebouncedDraftAck(message.chatId);
      const draft = (user.knowledgeDraft ?? "").trim();
      if (!draft) {
        await this.sendMessage(message.chatId, onboarding.emptyDone);
        return true;
      }
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          knowledgeScopeText: draft,
          knowledgeDraft: null,
          telegramKnowledgeAwaiting: false,
        },
      });
      await this.sendMessage(message.chatId, onboarding.saved);
      return true;
    }

    if (raw.startsWith("/")) {
      await this.sendMessage(message.chatId, onboarding.awaitingSlash);
      return true;
    }

    const sep = user.knowledgeDraft && user.knowledgeDraft.length > 0 ? "\n\n" : "";
    const nextDraft = (user.knowledgeDraft ?? "") + sep + raw;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { knowledgeDraft: nextDraft },
    });
    this.scheduleDebouncedDraftAck(message.chatId);
    return true;
  }

  async sendMessage(chatId: number, text: string): Promise<boolean> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      this.logger.warn("TELEGRAM_BOT_TOKEN is not set");
      return false;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      this.logger.error(`Telegram send failed: ${response.status} ${errText}`);
      return false;
    }
    return true;
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
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      return;
    }
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
