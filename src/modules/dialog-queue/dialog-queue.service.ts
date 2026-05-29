import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { Queue } from "bullmq";
import { isDevelopment } from "../shared/is-development";
import { DialogInboundJob } from "./dialog-inbound-job.types";
import { DIALOG_INBOUND_QUEUE_NAME, isDialogQueueEnabled } from "./dialog-queue.constants";
import { createRedisConnectionForBullmq } from "./redis-connection";

@Injectable()
export class DialogQueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(DialogQueueService.name);
  private connection: ReturnType<typeof createRedisConnectionForBullmq> | undefined;
  private queue: Queue | undefined;

  isEnabled(): boolean {
    return isDialogQueueEnabled();
  }

  private ensureQueue(): Queue {
    if (!this.queue) {
      this.connection = createRedisConnectionForBullmq();
      this.queue = new Queue(DIALOG_INBOUND_QUEUE_NAME, {
        connection: this.connection,
      });
    }
    return this.queue;
  }

  /**
   * Счётчики задач в Redis (для мониторинга / метрик).
   * Подключается к Redis при первом вызове, если очередь включена.
   */
  async getMetrics(): Promise<
    | { enabled: false }
    | { enabled: true; queue: string; counts: Record<string, number> }
  > {
    if (!isDialogQueueEnabled()) {
      return { enabled: false };
    }
    const queue = this.ensureQueue();
    const counts = await queue.getJobCounts();
    return { enabled: true, queue: DIALOG_INBOUND_QUEUE_NAME, counts };
  }

  async enqueue(job: DialogInboundJob): Promise<void> {
    // jobId не задаём: Telegram messageId уникален только в рамках чата и переиспользуется
    // между сессиями/перезапусками — детерминированный jobId ловит коллизии со старыми
    // completed-job'ами в Redis и тихо no-op'ит add(). Дедуп вебхуков делается в PG
    // через ProcessedInboundMessage (IdempotencyService).
    await this.ensureQueue().add("run", job, {
      removeOnComplete: { age: 3600, count: 200 },
      removeOnFail: { age: 86400, count: 1000 },
      attempts: Number(process.env.DIALOG_QUEUE_ATTEMPTS ?? 5),
      backoff: {
        type: "exponential",
        delay: Number(process.env.DIALOG_QUEUE_BACKOFF_MS ?? 3000),
      },
    });
    if (isDevelopment()) {
      this.logger.log(`Enqueued ${job.channel} job`);
    }
  }

  async onApplicationShutdown() {
    if (this.queue) {
      await this.queue.close();
    }
    if (this.connection) {
      await this.connection.quit();
    }
  }
}
