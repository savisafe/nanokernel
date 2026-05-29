import { Controller, Get, HttpException, HttpStatus, Logger, Query } from "@nestjs/common";
import { isDialogQueueEnabled, isDialogQueueWorkerEnabled } from "../dialog-queue/dialog-queue.constants";
import { DialogQueueService } from "../dialog-queue/dialog-queue.service";
import { BotUsageService } from "../bot-usage/bot-usage.service";

@Controller("health")
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly dialogQueue: DialogQueueService,
    private readonly botUsage: BotUsageService,
  ) {}

  @Get()
  getHealth() {
    return {
      status: "ok",
      service: "ai-bot",
      timestamp: new Date().toISOString(),
    };
  }

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

  @Get("usage")
  async getUsage(
    @Query("bot") botId?: string,
    @Query("hours") hoursRaw?: string,
  ) {
    const sinceHours = this.parseHours(hoursRaw);
    try {
      const summary = await this.botUsage.summarize({ botId, sinceHours });
      return {
        timestamp: new Date().toISOString(),
        botId: botId ?? "(all)",
        sinceHours,
        ...summary,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Usage summary failed: ${msg}`);
      throw new HttpException(
        {
          status: "error",
          message: "Cannot read usage summary (database unreachable?)",
          detail: msg,
          timestamp: new Date().toISOString(),
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private parseHours(raw?: string): number {
    if (raw === undefined || raw === "") {
      return 24;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return 24;
    }
    return Math.min(720, Math.floor(n));
  }
}
