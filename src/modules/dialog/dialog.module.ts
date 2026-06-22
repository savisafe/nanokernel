import { Module } from "@nestjs/common";
import { PromptProfileModule } from "../prompt-profile/prompt-profile.module";
import { RagModule } from "../rag/rag.module";
import { DialogService } from "./dialog.service";
import { ContextCompactionService } from "./context-compaction.service";

@Module({
  imports: [PromptProfileModule, RagModule],
  providers: [DialogService, ContextCompactionService],
  exports: [DialogService],
})
export class DialogModule {}
