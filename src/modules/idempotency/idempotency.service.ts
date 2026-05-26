import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param scope — chat-scope для канала (Telegram chatId, WhatsApp `from`). Нужен потому,
   * что provider'ские messageId уникальны только в рамках чата: без scope два разных чата
   * с одинаковым messageId маскируются друг за друга и второе сообщение тихо отбрасывается.
   */
  async tryProcess(
    channel: string,
    scope: string,
    externalMessageId?: string,
  ): Promise<boolean> {
    if (!externalMessageId) {
      return true;
    }

    try {
      await this.prisma.processedInboundMessage.create({
        data: { channel, scope, externalMessageId },
      });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return false;
      }
      throw error;
    }
  }

  /** Если постановка в очередь не удалась после tryProcess — чтобы провайдер мог повторить вебхук. */
  async revert(
    channel: string,
    scope: string,
    externalMessageId?: string,
  ): Promise<void> {
    if (!externalMessageId) {
      return;
    }
    await this.prisma.processedInboundMessage.deleteMany({
      where: { channel, scope, externalMessageId },
    });
  }
}
