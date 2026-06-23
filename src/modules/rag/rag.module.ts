import { Module } from "@nestjs/common";
import { RagService } from "./rag.service";
import { PromptProfileModule } from "../prompt-profile/prompt-profile.module";
import { BotConfigurationModule } from "../bot-configuration/bot-configuration.module";

@Module({
  imports: [PromptProfileModule, BotConfigurationModule],
  providers: [RagService],
  exports: [RagService],
})
export class RagModule {}
