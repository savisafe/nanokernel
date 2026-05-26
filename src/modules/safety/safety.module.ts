import { Global, Module } from "@nestjs/common";
import { RateLimitService } from "./rate-limit.service";
import { SafetyInService } from "./safety-in.service";
import { SafetyOutService } from "./safety-out.service";

@Global()
@Module({
  providers: [RateLimitService, SafetyInService, SafetyOutService],
  exports: [SafetyInService, SafetyOutService],
})
export class SafetyModule {}
