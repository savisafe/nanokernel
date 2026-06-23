import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import IORedis from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Если Redis недоступен — fail-open, поле true. */
  degraded: boolean;
}

/**
 * Простой rate-limit на счётчике с TTL. Sliding window не точный, но дешёвый и
 * предсказуемый — для антиспама достаточно.
 *
 * Ключ: `safety:rl:{channel}:{externalUserId}`.
 * Поведение при недоступности Redis — fail-open с логом (разовый, не на каждый запрос).
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private connection: IORedis | undefined;
  private warnedDegraded = false;

  async check(key: string, maxRequests: number, windowSeconds: number): Promise<RateLimitResult> {
    const redis = this.ensureConnection();
    if (!redis) {
      this.warnDegraded("no redis configured");
      return { allowed: true, remaining: maxRequests, degraded: true };
    }
    try {
      const fullKey = `safety:rl:${key}`;
      const count = await redis.incr(fullKey);
      if (count === 1) {
        await redis.expire(fullKey, windowSeconds);
      }
      return {
        allowed: count <= maxRequests,
        remaining: Math.max(0, maxRequests - count),
        degraded: false,
      };
    } catch (e) {
      this.warnDegraded(e instanceof Error ? e.message : String(e));
      return { allowed: true, remaining: maxRequests, degraded: true };
    }
  }

  onModuleDestroy(): void {
    if (this.connection) {
      this.connection.quit().catch(() => undefined);
      this.connection = undefined;
    }
  }

  private ensureConnection(): IORedis | undefined {
    if (this.connection) {
      return this.connection;
    }
    const host = process.env.REDIS_HOST ?? "localhost";
    const port = Number(process.env.REDIS_PORT ?? 6379);
    const password = process.env.REDIS_PASSWORD;
    try {
      this.connection = new IORedis({
        host,
        port,
        ...(password ? { password } : {}),
        // Короткие ретраи: rate-limit не должен подвешивать пайплайн.
        maxRetriesPerRequest: 2,
        lazyConnect: false,
        connectTimeout: 1500,
      });
      this.connection.on("error", (e) => {
        this.warnDegraded(`redis error: ${e.message}`);
      });
      return this.connection;
    } catch (e) {
      this.warnDegraded(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }

  private warnDegraded(reason: string): void {
    if (!this.warnedDegraded) {
      this.logger.warn(`Rate-limit degraded (fail-open): ${reason}`);
      this.warnedDegraded = true;
    }
  }
}
