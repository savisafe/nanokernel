import { Module } from "@nestjs/common";
import { BotConfigurationModule } from "./bot-configuration/bot-configuration.module";
import { DialogQueueModule } from "./dialog-queue/dialog-queue.module";
import { DialogModule } from "./dialog/dialog.module";
import { HealthModule } from "./health/health.module";
import { IdempotencyModule } from "./idempotency/idempotency.module";
import { LlmModule } from "./llm/llm.module";
import { PrismaModule } from "./prisma/prisma.module";
import { TelegramModule } from "./telegram/telegram.module";
import { WhatsAppModule } from "./whatsapp/whatsapp.module";
import { RagModule } from "./rag/rag.module";

@Module({
  imports: [
    BotConfigurationModule,
    PrismaModule,
    IdempotencyModule,
    LlmModule,
    DialogModule,
    DialogQueueModule,
    HealthModule,
    WhatsAppModule,
    TelegramModule,
    RagModule,
  ],
})
export class AppModule {}
