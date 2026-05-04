import { Controller, Get, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { isDialogQueueEnabled, isDialogQueueWorkerEnabled } from "../dialog-queue/dialog-queue.constants";
import { DialogQueueService } from "../dialog-queue/dialog-queue.service";

@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly dialogQueue: DialogQueueService) {}

  @Get()
  getHealth() {
    return {
      status: "ok",
      service: "ai-bot",
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Мониторинг BullMQ: ожидание, активные, упавшие и т.д.
   * При недоступном Redis — 503.
   */
  @Get("queue")
  async getQueueMetrics() {
    if (!isDialogQueueEnabled()) {
      return {
        timestamp: new Date().toISOString(),
        queueEnabled: false,
        workerEnabled: false,
      };
    }

    try {
      const metrics = await this.dialogQueue.getMetrics();
      if (!metrics.enabled) {
        return {
          timestamp: new Date().toISOString(),
          queueEnabled: false,
          workerEnabled: false,
        };
      }
      return {
        timestamp: new Date().toISOString(),
        queueEnabled: true,
        workerEnabled: isDialogQueueWorkerEnabled(),
        queue: metrics.queue,
        counts: metrics.counts,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Queue metrics failed: ${msg}`);
      throw new HttpException(
        {
          status: "error",
          message: "Cannot read queue metrics (Redis unreachable?)",
          detail: msg,
          timestamp: new Date().toISOString(),
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
