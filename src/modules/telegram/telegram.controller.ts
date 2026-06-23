import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
} from "@nestjs/common";
import { BotConfigurationService } from "../bot-configuration/bot-configuration.service";
import { TelegramService } from "./telegram.service";
import { TelegramWebhookPayload } from "./telegram.types";

@Controller("webhooks/telegram")
export class TelegramController {
  constructor(
    private readonly telegramService: TelegramService,
    private readonly botConfiguration: BotConfigurationService,
  ) {}

  @Get("health")
  health() {
    return { status: "ok", channel: "telegram" };
  }

  /**
   * Multi-bot маршрут: один процесс обслуживает N ботов через разные секреты.
   * Telegram POST'ит на /webhooks/telegram/<webhookSecret>. Резолвим bot по
   * секрету и пропускаем через тот же pipeline. Опциональная защита через
   * X-Telegram-Bot-Api-Secret-Token, если в конфиге задан apiSecretToken.
   */
  @Post(":secret")
  @HttpCode(200)
  async webhookBySecret(
    @Param("secret") secret: string,
    @Body() payload: TelegramWebhookPayload,
    @Headers("x-telegram-bot-api-secret-token") apiSecretToken?: string,
  ) {
    const bot = this.botConfiguration.resolveByWebhookSecret(secret);
    if (!bot) {
      throw new HttpException("Unknown webhook secret", HttpStatus.NOT_FOUND);
    }
    const expected = bot.channel?.telegram?.apiSecretToken;
    if (expected && expected !== apiSecretToken) {
      throw new HttpException("Invalid api secret token", HttpStatus.UNAUTHORIZED);
    }
    await this.telegramService.handleIncoming(payload, bot);
    return { ok: true };
  }

  /**
   * Legacy маршрут: единственный бот процесса через env BOT_CONFIGURATION + TELEGRAM_BOT_TOKEN.
   * Остаётся, чтобы не ломать существующие развёртывания. Снос — Фаза 9.
   */
  @Post()
  @HttpCode(200)
  async webhook(@Body() payload: TelegramWebhookPayload) {
    const bot = this.botConfiguration.get();
    await this.telegramService.handleIncoming(payload, bot);
    return { ok: true };
  }
}
