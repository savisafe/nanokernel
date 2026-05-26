import { forwardRef, Module } from "@nestjs/common";
import { DialogQueueModule } from "../dialog-queue/dialog-queue.module";
import { DialogModule } from "../dialog/dialog.module";
import { TelegramController } from "./telegram.controller";
import { TelegramService } from "./telegram.service";

@Module({
  imports: [DialogModule, forwardRef(() => DialogQueueModule)],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
