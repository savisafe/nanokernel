import { Module } from "@nestjs/common";
import { PromptProfileService } from "./prompt-profile.service";

@Module({
  providers: [PromptProfileService],
  exports: [PromptProfileService],
})
export class PromptProfileModule {}
