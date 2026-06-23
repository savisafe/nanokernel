import { Injectable, Logger } from "@nestjs/common";
import type { ChannelAdapter } from "../channels/channel-adapter.contract";
import type { DialogInboundJob } from "../dialog-queue/dialog-inbound-job.types";
import { DialogService } from "../dialog/dialog.service";
import type { ChannelType } from "../dialog/dialog.types";

/**
 * HTTP-канал — не-мессенджер транспорт для прогона агента (напр. ИИ-программиста)
 * без Telegram/WhatsApp. Реализует тот же ChannelAdapter, что и мессенджеры, но
 * HTTP — request/response, поэтому есть два пути:
 *  - синхронный `handle()` (используется контроллером): прогнать диалог и вернуть
 *    ответ прямо в HTTP-ответе — без Redis/очереди;
 *  - `processInbound()` (контракт ChannelAdapter): ответ кладётся в `pending` для
 *    последующей выборки, чтобы адаптер работал и через очередной воркер.
 */
@Injectable()
export class HttpChannelService implements ChannelAdapter {
  readonly channelId: ChannelType = "http";
  private readonly logger = new Logger(HttpChannelService.name);
  private readonly pending = new Map<string, string>();

  constructor(private readonly dialog: DialogService) {}

  /** Синхронный путь: прогнать диалог и вернуть ответ напрямую. */
  async handle(sessionId: string, text: string): Promise<string> {
    const out = await this.dialog.process({ channel: "http", externalUserId: sessionId, text });
    return out.replyText;
  }

  async processInbound(job: DialogInboundJob): Promise<void> {
    if (job.channel !== "http") {
      return;
    }
    const out = await this.dialog.process({
      channel: "http",
      externalUserId: job.sessionId,
      text: job.text,
    });
    await this.sendText(job.sessionId, out.replyText);
  }

  async sendText(recipient: string, text: string): Promise<boolean> {
    this.pending.set(recipient, text);
    return true;
  }

  /** Забрать (и удалить) отложенный ответ для сессии — для очередного пути. */
  takePending(sessionId: string): string | undefined {
    const reply = this.pending.get(sessionId);
    if (reply !== undefined) {
      this.pending.delete(sessionId);
    }
    return reply;
  }
}
