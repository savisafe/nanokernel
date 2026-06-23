import { forwardRef, Module } from "@nestjs/common";
import { TelegramModule } from "../telegram/telegram.module";
import { WhatsAppModule } from "../whatsapp/whatsapp.module";
import { DialogQueueService } from "./dialog-queue.service";
import { DialogQueueWorkerService } from "./dialog-queue-worker.service";

@Module({
  imports: [forwardRef(() => TelegramModule), forwardRef(() => WhatsAppModule)],
  providers: [DialogQueueService, DialogQueueWorkerService],
  exports: [DialogQueueService],
})
export class DialogQueueModule {}
