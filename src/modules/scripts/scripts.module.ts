import { Global, Module } from "@nestjs/common";
import { ScriptRunnerService } from "./script-runner.service";
import { SlotExtractorService } from "./slot-extractor.service";

@Global()
@Module({
  providers: [ScriptRunnerService, SlotExtractorService],
  exports: [ScriptRunnerService],
})
export class ScriptsModule {}
