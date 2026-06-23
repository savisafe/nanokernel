import { forwardRef, Module } from "@nestjs/common";
import { DialogQueueModule } from "../dialog-queue/dialog-queue.module";
import { DialogModule } from "../dialog/dialog.module";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppService } from "./whatsapp.service";

@Module({
  imports: [DialogModule, forwardRef(() => DialogQueueModule)],
  controllers: [WhatsAppController],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
