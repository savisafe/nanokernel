import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { Job, Worker } from "bullmq";
import { TelegramService } from "../telegram/telegram.service";
import { WhatsAppService } from "../whatsapp/whatsapp.service";
import { BotConfigurationService } from "../bot-configuration/bot-configuration.service";
import { isDevelopment } from "../shared/is-development";
import { DialogInboundJob } from "./dialog-inbound-job.types";
import {
  DIALOG_INBOUND_QUEUE_NAME,
  isDialogQueueEnabled,
  isDialogQueueWorkerEnabled,
} from "./dialog-queue.constants";
import { createRedisConnectionForBullmq } from "./redis-connection";

@Injectable()
export class DialogQueueWorkerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DialogQueueWorkerService.name);
  private readonly connection = createRedisConnectionForBullmq();
  private worker: Worker | undefined;

  constructor(
    @Inject(forwardRef(() => TelegramService))
    private readonly telegramService: TelegramService,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsAppService: WhatsAppService,
    private readonly botConfigurationService: BotConfigurationService,
  ) {}

  onModuleInit() {
    if (!isDialogQueueEnabled()) {
      this.logger.log("Dialog queue worker not started (DIALOG_QUEUE_ENABLED=false)");
      return;
    }
    if (!isDialogQueueWorkerEnabled()) {
      this.logger.warn("Dialog queue worker disabled (DIALOG_QUEUE_WORKER_ENABLED=false)");
      return;
    }
    const concurrency = Math.max(1, Number(process.env.DIALOG_QUEUE_CONCURRENCY ?? 2));
    this.worker = new Worker(
      DIALOG_INBOUND_QUEUE_NAME,
      async (job: Job<DialogInboundJob>) => {
        const data = job.data;
        if (data.channel === "telegram") {
          const bot = this.botConfigurationService.resolveById(data.botId);
          await this.telegramService.processInboundQueued(data, bot);
        } else {
          await this.whatsAppService.processInboundQueued(data);
        }
      },
      { connection: this.connection, concurrency },
    );
    this.worker.on("failed", (job, err) => {
      this.logger.error(
        `Job failed id=${job?.id ?? "n/a"}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    if (isDevelopment()) {
      this.worker.on("active", (job) => {
        const ch = job.data?.channel ?? "?";
        this.logger.log(`[Queue] job active id=${job.id} channel=${ch}`);
      });
      this.worker.on("completed", (job) => {
        this.logger.log(`[Queue] job completed id=${job.id}`);
      });
      this.logger.log(`Dialog queue worker started (concurrency=${concurrency})`);
    }
  }

  async onApplicationShutdown() {
    if (this.worker) {
      await this.worker.close();
    }
    await this.connection.quit();
  }
}
