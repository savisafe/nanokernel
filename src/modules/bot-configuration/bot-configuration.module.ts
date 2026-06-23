import { Global, Module } from "@nestjs/common";
import { BotConfigurationService } from "./bot-configuration.service";

@Global()
@Module({
  providers: [BotConfigurationService],
  exports: [BotConfigurationService],
})
export class BotConfigurationModule {}
