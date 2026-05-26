import { forwardRef, Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { performance } from "node:perf_hooks";
import type { DocumentIngestResult } from "../document-ingest/document-ingest.service";
import { DocumentIngestService } from "../document-ingest/document-ingest.service";
import type { DialogTelegramKnowledgeOnboarding } from "../dialog/dialog.config.types";
import { DialogQueueService } from "../dialog-queue/dialog-queue.service";
import { DialogService } from "../dialog/dialog.service";
import { DialogOutput } from "../dialog/dialog.types";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { PrismaService } from "../prisma/prisma.service";
import { isDevelopment } from "../shared/is-development";
import type { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import { telegramBotAls, resolveTelegramToken } from "./telegram-bot-context";
import {
  type TelegramApiMessage,
  type TelegramUnsupportedAttachment,
  type TelegramCallbackQuery,
  IncomingTelegramMessage,
  TelegramWebhookPayload,
} from "./telegram.types";

/** Префикс callback_data для выбора config/configurations/&lt;slug&gt;.json в Telegram */
const TELEGRAM_BOT_CONFIGURATION_CALLBACK_PREFIX = "bot_cfg:";
const TELEGRAM_BOT_CONFIGURATION_CHOICE_SLUGS = new Set(["knowledge-consultant", "open-topics"]);

@Injectable()
export class TelegramService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly draftAckTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly inboundChains = new Map<number, Promise<void>>();
  private static readonly KNOWLEDGE_QUESTION_BEFORE_DONE_MAX_CHARS = 200;
  private static readonly DOCUMENT_EXTRACT_SHORT_CHARS = 80;

  constructor(
    private readonly dialogService: DialogService,
    private readonly documentIngest: DocumentIngestService,
    private readonly idempotencyService: IdempotencyService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => DialogQueueService))
    private readonly dialogQueueService: DialogQueueService,
  ) {}

  private static telegramCommandToken(rawTrimmed: string): string {
    const first = rawTrimmed.split(/\s+/)[0] ?? "";
    const base = first.includes("@") ? (first.split("@")[0] ?? first) : first;
    return base.toLowerCase();
  }

  /** Сообщение состоит только из URL — в черновик не кладём (импорт по ссылке пока не поддерживается). */
  private static isUrlOnlyKnowledgeDraftInput(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    const tokens = t.split(/\s+/).filter((x) => x.length > 0);
    const normalize = (s: string) =>
      s.replace(/^<|>$/g, "").replace(/^\(+/, "").replace(/\)+$/u, "").trim();
    const looksLikeUrl = (s: string) => {
      const u = normalize(s);
      return /^https?:\/\//i.test(u) || /^www\.\S+/i.test(u);
    };
    return tokens.every(looksLikeUrl);
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

  private async scheduleDebouncedDraftAck(chatId: number): Promise<void> {
    const onboarding = await this.dialogService.getTelegramKnowledgeOnboardingForExternalUser(String(chatId));
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
    const onboarding = await this.dialogService.getTelegramKnowledgeOnboardingForExternalUser(externalId);
    await this.sendMessage(chatId, onboarding.draftSavedAck);
  }

  private static messageFromUpdate(payload: TelegramWebhookPayload): TelegramApiMessage | undefined {
    return payload.message ?? payload.channel_post ?? payload.edited_message;
  }

  private static detectUnsupportedAttachment(msg: TelegramApiMessage): TelegramUnsupportedAttachment | undefined {
    if (msg.photo && msg.photo.length > 0) {
      return "photo";
    }
    if (msg.voice?.file_id) {
      return "voice";
    }
    if (msg.audio?.file_id) {
      return "audio";
    }
    if (msg.video?.file_id) {
      return "video";
    }
    if (msg.video_note?.file_id) {
      return "video_note";
    }
    if (msg.sticker?.file_id) {
      return "sticker";
    }
    return undefined;
  }

  extractMessage(payload: TelegramWebhookPayload): IncomingTelegramMessage | null {
    const message = TelegramService.messageFromUpdate(payload);
    if (!message) {
      return null;
    }
    const chatId = message.chat?.id;
    if (typeof chatId !== "number") {
      return null;
    }

    const doc = message.document;
    const combinedText = (message.text ?? message.caption ?? "").trim();

    if (doc) {
      if (!doc.file_id) {
        this.logger.warn(
          `Telegram document without file_id (chatId=${chatId} message_id=${message.message_id ?? "?"})`,
        );
      } else {
        return {
          chatId,
          text: combinedText,
          messageId: message.message_id,
          document: {
            fileId: doc.file_id,
            fileName: doc.file_name,
            mimeType: doc.mime_type,
          },
        };
      }
    }

    if (combinedText) {
      return {
        chatId,
        text: combinedText,
        messageId: message.message_id,
      };
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
      `Telegram update ignored (no text/file we handle): update_id=${payload.update_id ?? "?"} payloadKeys=${payloadKeys} messageKeys=${msgKeys}`,
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
      await this.handleBotConfigurationCallback(payload.callback_query);
      return;
    }

    const message = this.extractMessage(payload);
    if (!message) {
      this.logSkippedTelegramUpdate(payload);
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
    const preview = message.unsupportedAttachment
      ? `[unsupported:${message.unsupportedAttachment}]`
      : message.document
        ? `[document ${message.document.fileName ?? "file"}${message.text ? ` + ${message.text.slice(0, 80)}` : ""}]`
        : message.text.length > 120
          ? `${message.text.slice(0, 120)}…`
          : message.text;
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
        await this.idempotencyService.revert("telegram", message.messageId?.toString());
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
    const composed = prev
      .catch(() => {
        //TODO add error logs
      })
      .then(() => task());
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
    const handledKnowledge = await this.tryHandleTelegramKnowledgeOnboarding(message);
    if (handledKnowledge) {
      return;
    }

    const onboardingEarly = await this.dialogService.getTelegramKnowledgeOnboardingForExternalUser(
      String(message.chatId),
    );
    if (message.document) {
      await this.sendMessage(message.chatId, onboardingEarly.documentOutsideKnowledgeMode);
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
    const onboarding = await this.dialogService.getTelegramKnowledgeOnboardingForExternalUser(externalId);

    if (cmd === "/start") {
      await this.sendMessage(message.chatId, onboarding.modeChoiceCaption, {
        replyMarkup: {
          inline_keyboard: [
            [
              {
                text: onboarding.modeButtonKnowledgeConsultant,
                callback_data: `${TELEGRAM_BOT_CONFIGURATION_CALLBACK_PREFIX}knowledge-consultant`,
              },
              {
                text: onboarding.modeButtonOpenTopics,
                callback_data: `${TELEGRAM_BOT_CONFIGURATION_CALLBACK_PREFIX}open-topics`,
              },
            ],
          ],
        },
      });
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

    if (message.unsupportedAttachment) {
      const hint = user?.telegramKnowledgeAwaiting
        ? onboarding.attachmentNotDocumentHint
        : onboarding.documentOutsideKnowledgeMode;
      await this.sendMessage(message.chatId, hint);
      return true;
    }

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

    if (message.document) {
      try {
        const buf = await this.downloadTelegramFile(message.document.fileId);
        if (buf.length > this.maxTelegramDocumentBytes()) {
          await this.sendMessage(message.chatId, onboarding.documentTooLarge);
          return true;
        }
        const extracted = await this.documentIngest.extractText(buf, {
          fileName: message.document.fileName,
          mimeType: message.document.mimeType,
        });
        if (!extracted.ok) {
          await this.sendMessage(message.chatId, this.ingestFailureReply(onboarding, extracted));
          return true;
        }
        let piece = extracted.text;
        if (raw.length > 0) {
          piece = `${extracted.text}\n\n${raw}`;
        }
        const sep = user.knowledgeDraft && user.knowledgeDraft.length > 0 ? "\n\n" : "";
        const nextDraft = (user.knowledgeDraft ?? "") + sep + piece;
        await this.prisma.user.update({
          where: { id: user.id },
          data: { knowledgeDraft: nextDraft },
        });
        if (isDevelopment()) {
          this.logger.log(
            `[Telegram] knowledge draft appended from document chars=${piece.length} file=${message.document.fileName ?? "unknown"}`,
          );
        }
        this.clearDebouncedDraftAck(message.chatId);
        const baseName = message.document.fileName?.trim();
        const fileLabel = baseName ? ` «${baseName}»` : "";
        const pieceChars = [...piece].length;
        const ack = onboarding.documentAcceptedAck
          .replace("{fileLabel}", fileLabel)
          .replace("{chars}", String(pieceChars));
        await this.sendMessage(message.chatId, ack);
        if (pieceChars < TelegramService.DOCUMENT_EXTRACT_SHORT_CHARS) {
          await this.sendMessage(message.chatId, onboarding.documentExtractShortWarning);
        }
        return true;
      } catch (e) {
        this.logger.warn(
          `Telegram document ingest failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        await this.sendMessage(message.chatId, onboarding.documentDownloadFailed);
        return true;
      }
    }

    if (
      raw.length > 0 &&
      raw.length <= TelegramService.KNOWLEDGE_QUESTION_BEFORE_DONE_MAX_CHARS &&
      this.dialogService.isGlobalKnowledgeIntent(raw)
    ) {
      await this.sendMessage(message.chatId, onboarding.questionBeforeDoneHint);
      return true;
    }

    if (TelegramService.isUrlOnlyKnowledgeDraftInput(raw)) {
      await this.sendMessage(message.chatId, onboarding.linkNotSupportedInDraft);
      return true;
    }

    const sep = user.knowledgeDraft && user.knowledgeDraft.length > 0 ? "\n\n" : "";
    const nextDraft = (user.knowledgeDraft ?? "") + sep + raw;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { knowledgeDraft: nextDraft },
    });
    await this.scheduleDebouncedDraftAck(message.chatId);
    return true;
  }

  /**
   * Inline-кнопки после /start: сохраняем slug сборки в User.selectedBotConfigurationId.
   */
  private async handleBotConfigurationCallback(query: TelegramCallbackQuery): Promise<void> {
    const chatId = query.message?.chat?.id;
    const data = query.data?.trim();
    const callbackQueryId = query.id;
    if (typeof chatId !== "number" || !callbackQueryId || !data?.startsWith(TELEGRAM_BOT_CONFIGURATION_CALLBACK_PREFIX)) {
      return;
    }

    const slug = data.slice(TELEGRAM_BOT_CONFIGURATION_CALLBACK_PREFIX.length);
    if (!TELEGRAM_BOT_CONFIGURATION_CHOICE_SLUGS.has(slug)) {
      await this.answerCallbackQuery(callbackQueryId);
      return;
    }

    const shouldProcess = await this.idempotencyService.tryProcess("telegram", `cb:${callbackQueryId}`);
    if (!shouldProcess) {
      await this.answerCallbackQuery(callbackQueryId);
      return;
    }

    const externalId = String(chatId);
    await this.prisma.user.upsert({
      where: {
        channel_externalId: { channel: "telegram", externalId },
      },
      create: {
        channel: "telegram",
        externalId,
        selectedBotConfigurationId: slug,
      },
      update: {
        selectedBotConfigurationId: slug,
      },
    });

    await this.answerCallbackQuery(callbackQueryId);

    const onboarding = await this.dialogService.getTelegramKnowledgeOnboardingForExternalUser(externalId);
    const confirmation =
      slug === "knowledge-consultant"
        ? onboarding.modeAppliedKnowledgeConsultant
        : onboarding.modeAppliedOpenTopics;
    await this.sendMessage(chatId, confirmation);
  }

  private async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    const token = resolveTelegramToken();
    if (!token) {
      return;
    }
    const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQueryId }),
      });
      if (!response.ok) {
        const errText = await response.text();
        this.logger.warn(`Telegram answerCallbackQuery failed: ${response.status} ${errText}`);
      }
    } catch (e) {
      this.logger.warn(`Telegram answerCallbackQuery error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async sendMessage(
    chatId: number,
    text: string,
    options?: { replyMarkup?: Record<string, unknown> },
  ): Promise<boolean> {
    const token = resolveTelegramToken();
    if (!token) {
      this.logger.warn("Telegram token not resolved (channel.telegram.tokenEnv or TELEGRAM_BOT_TOKEN)");
      return false;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (options?.replyMarkup) {
      body.reply_markup = options.replyMarkup;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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

  private maxTelegramDocumentBytes(): number {
    const n = Number(process.env.TELEGRAM_DOCUMENT_MAX_BYTES);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20 * 1024 * 1024;
  }

  private async downloadTelegramFile(fileId: string): Promise<Buffer> {
    const token = resolveTelegramToken();
    if (!token) {
      throw new Error("Telegram token not resolved (channel.telegram.tokenEnv or TELEGRAM_BOT_TOKEN)");
    }
    const getFileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const gf = await fetch(getFileUrl);
    const json = (await gf.json()) as {
      ok?: boolean;
      result?: { file_path?: string };
      description?: string;
    };
    if (!json.ok || !json.result?.file_path) {
      throw new Error(json.description ?? "getFile failed");
    }
    const fileUrl = `https://api.telegram.org/file/bot${token}/${json.result.file_path}`;
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) {
      throw new Error(`file download HTTP ${fileRes.status}`);
    }
    return Buffer.from(await fileRes.arrayBuffer());
  }

  private ingestFailureReply(
    onboarding: DialogTelegramKnowledgeOnboarding,
    result: Extract<DocumentIngestResult, { ok: false }>,
  ): string {
    switch (result.kind) {
      case "unsupported":
        return onboarding.documentUnsupportedFormat;
      case "empty":
        return onboarding.documentExtractEmpty;
      case "parse_error":
        return onboarding.documentExtractFailed;
      default:
        return onboarding.documentExtractFailed;
    }
  }

  private async sendChatAction(chatId: number, action: string): Promise<void> {
    const token = resolveTelegramToken();
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
