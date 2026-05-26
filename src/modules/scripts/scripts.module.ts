import { Global, Module } from "@nestjs/common";
import { ScriptRunnerService } from "./script-runner.service";

@Global()
@Module({
  providers: [ScriptRunnerService],
  exports: [ScriptRunnerService],
})
export class ScriptsModule {}
