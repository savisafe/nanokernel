import { Global, Module } from "@nestjs/common";
import { BotUsageService } from "./bot-usage.service";

@Global()
@Module({
  providers: [BotUsageService],
  exports: [BotUsageService],
})
export class BotUsageModule {}
