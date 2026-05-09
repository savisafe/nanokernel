import { forwardRef, Module } from "@nestjs/common";
import { DocumentIngestModule } from "../document-ingest/document-ingest.module";
import { DialogQueueModule } from "../dialog-queue/dialog-queue.module";
import { DialogModule } from "../dialog/dialog.module";
import { TelegramController } from "./telegram.controller";
import { TelegramService } from "./telegram.service";

@Module({
  imports: [DialogModule, DocumentIngestModule, forwardRef(() => DialogQueueModule)],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
