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
import { SnippetsModule } from "./snippets/snippets.module";
import { BotUsageModule } from "./bot-usage/bot-usage.module";
import { SkillsModule } from "./skills/skills.module";
import { ScriptsModule } from "./scripts/scripts.module";
import { SafetyModule } from "./safety/safety.module";
import { McpModule } from "./mcp/mcp.module";

@Module({
  imports: [
    BotConfigurationModule,
    PrismaModule,
    IdempotencyModule,
    LlmModule,
    SnippetsModule,
    BotUsageModule,
    McpModule,
    SkillsModule,
    ScriptsModule,
    SafetyModule,
    DialogModule,
    DialogQueueModule,
    HealthModule,
    WhatsAppModule,
    TelegramModule,
    RagModule,
  ],
})
export class AppModule {}
