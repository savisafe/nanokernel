import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    const maxAttempts = Math.max(1, Number(process.env.PRISMA_CONNECT_MAX_ATTEMPTS ?? 30));
    const delayMs = Math.max(100, Number(process.env.PRISMA_CONNECT_RETRY_DELAY_MS ?? 1000));
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.$connect();
        if (attempt > 1) {
          this.logger.log(`Connected to PostgreSQL after ${attempt} attempt(s).`);
        }
        return;
      } catch (e) {
        lastError = e;
        if (attempt < maxAttempts) {
          this.logger.warn(
            `Database unreachable (attempt ${attempt}/${maxAttempts}); retrying in ${delayMs}ms…`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    this.logger.error(
      `Could not connect after ${maxAttempts} attempts. Start PostgreSQL (e.g. \`npm run db:up\`) and check DATABASE_URL.`,
    );
    throw lastError;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
