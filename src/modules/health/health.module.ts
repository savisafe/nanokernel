import { Module } from "@nestjs/common";
import { DialogQueueModule } from "../dialog-queue/dialog-queue.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [DialogQueueModule],
  controllers: [HealthController],
})
export class HealthModule {}
