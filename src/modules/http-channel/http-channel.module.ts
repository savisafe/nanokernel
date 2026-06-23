import { Module } from "@nestjs/common";
import { DialogModule } from "../dialog/dialog.module";
import { HttpChannelController } from "./http-channel.controller";
import { HttpChannelService } from "./http-channel.service";

/**
 * HTTP-канал: не-мессенджер вход для прогона агентов (ИИ-программист и т.п.).
 * Импортирует DialogModule ради DialogService.
 */
@Module({
  imports: [DialogModule],
  controllers: [HttpChannelController],
  providers: [HttpChannelService],
  exports: [HttpChannelService],
})
export class HttpChannelModule {}
