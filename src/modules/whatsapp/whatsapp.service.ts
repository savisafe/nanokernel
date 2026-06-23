import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DialogQueueService } from "../dialog-queue/dialog-queue.service";
import { DialogService } from "../dialog/dialog.service";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { isDevelopment } from "../shared/is-development";
import type { ChannelAdapter } from "../channels/channel-adapter.contract";
import type { DialogInboundJob } from "../dialog-queue/dialog-inbound-job.types";
import { IncomingWhatsAppMessage, WhatsAppWebhookPayload } from "./whatsapp.types";

@Injectable()
export class WhatsAppService implements ChannelAdapter {
  readonly channelId = "whatsapp" as const;
  private readonly logger = new Logger(WhatsAppService.name);
  constructor(
    private readonly dialogService: DialogService,
    private readonly idempotencyService: IdempotencyService,
    @Inject(forwardRef(() => DialogQueueService))
    private readonly dialogQueueService: DialogQueueService,
  ) {}

  /** ChannelAdapter: путь воркера очереди (WhatsApp использует env-конфиг, бот не резолвится). */
  async processInbound(job: DialogInboundJob): Promise<void> {
    if (job.channel !== "whatsapp") {
      return;
    }
    await this.processInboundQueued(job);
  }

  /** ChannelAdapter: отправка текста (recipient — WhatsApp phone). */
  sendText(recipient: string, text: string): Promise<boolean> {
    return this.sendTextMessage(recipient, text);
  }

  verifyWebhook(mode?: string, token?: string, challenge?: string): string | null {
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!verifyToken) {
      this.logger.error("WHATSAPP_VERIFY_TOKEN is not set");
      return null;
    }

    if (mode === "subscribe" && token === verifyToken) {
      return challenge ?? "";
    }

    return null;
  }

  extractMessages(payload: WhatsAppWebhookPayload): IncomingWhatsAppMessage[] {
    const result: IncomingWhatsAppMessage[] = [];
    const entries = payload.entry ?? [];

    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const messages = change.value?.messages ?? [];
        for (const message of messages) {
          if (message.type !== "text") {
            continue;
          }
          const text = message.text?.body?.trim();
          const from = message.from?.trim();
          if (!text || !from) {
            continue;
          }
          result.push({
            from,
            text,
            messageId: message.id,
          });
        }
      }
    }

    return result;
  }

  verifySignature(rawBody: Buffer | undefined, signatureHeader?: string): boolean {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      this.logger.warn("WHATSAPP_APP_SECRET is not set, skipping signature verification");
      return true;
    }

    if (!rawBody || !signatureHeader?.startsWith("sha256=")) {
      return false;
    }

    const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
    const incoming = signatureHeader.slice("sha256=".length);

    const expectedBuf = Buffer.from(expected, "hex");
    const incomingBuf = Buffer.from(incoming, "hex");
    if (expectedBuf.length !== incomingBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, incomingBuf);
  }

  async handleIncoming(payload: WhatsAppWebhookPayload): Promise<void> {
    const messages = this.extractMessages(payload);

    for (const message of messages) {
      const shouldProcess = await this.idempotencyService.tryProcess(
        "whatsapp",
        message.from,
        message.messageId,
      );
      if (!shouldProcess) {
        this.logger.warn(`Duplicate WhatsApp message skipped: ${message.messageId ?? "unknown"}`);
        continue;
      }

      const dev = isDevelopment();
      const preview = message.text.length > 120 ? `${message.text.slice(0, 120)}…` : message.text;
      const flowStarted = dev ? performance.now() : 0;
      if (dev) {
        this.logger.log(
          `[WhatsApp] 1/3 received from=${message.from} messageId=${message.messageId ?? "n/a"}: ${preview}`,
        );
      }

      if (this.dialogQueueService.isEnabled()) {
        try {
          await this.dialogQueueService.enqueue({
            channel: "whatsapp",
            ...message,
          });
        } catch (e) {
          await this.idempotencyService.revert("whatsapp", message.from, message.messageId);
          throw e;
        }
        if (dev) {
          this.logger.log(
            `[WhatsApp] enqueued from=${message.from} messageId=${message.messageId ?? "n/a"} (${Math.round(performance.now() - flowStarted)}ms to ack path)`,
          );
        }
        continue;
      }

      await this.processInboundQueued(message, flowStarted);
    }
  }

  async processInboundQueued(
    message: IncomingWhatsAppMessage,
    flowStarted?: number,
  ): Promise<void> {
    const dev = isDevelopment();
    const flowT0 = flowStarted ?? (dev ? performance.now() : 0);
    const dialogStarted = dev ? performance.now() : 0;
    const result = await this.dialogService.process({
      channel: "whatsapp",
      externalUserId: message.from,
      text: message.text,
    });
    if (dev) {
      const dialogMs = Math.round(performance.now() - dialogStarted);
      this.logger.log(
        `[WhatsApp] 2/3 dialog done from=${message.from} stage=${result.stage} in ${dialogMs}ms`,
      );
    }

    const sendStarted = dev ? performance.now() : 0;
    const sent = await this.sendTextMessage(message.from, result.replyText);
    if (dev) {
      const sendMs = Math.round(performance.now() - sendStarted);
      const totalMs = Math.round(performance.now() - flowT0);
      this.logger.log(
        `[WhatsApp] 3/3 ${sent ? "reply sent to user" : "reply NOT sent (see errors above)"} to=${message.from} in ${sendMs}ms | total ${totalMs}ms (webhook → user sees message)`,
      );
    }
  }

  async sendTextMessage(to: string, body: string): Promise<boolean> {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!token || !phoneNumberId) {
      this.logger.warn("WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set");
      return false;
    }

    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      this.logger.error(`WhatsApp send failed: ${response.status} ${errText}`);
      return false;
    }
    return true;
  }
}
