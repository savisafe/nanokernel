import { Global, Module } from "@nestjs/common";
import { SnippetMatcherService } from "./snippet-matcher.service";

@Global()
@Module({
  providers: [SnippetMatcherService],
  exports: [SnippetMatcherService],
})
export class SnippetsModule {}
