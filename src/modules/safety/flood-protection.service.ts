import { createHash } from "node:crypto";
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import IORedis from "ioredis";
import type {
  ResolvedBurstLimit,
  ResolvedRepeatLimit,
} from "../bot-configuration/bot-configuration.types";

export interface FloodCheckResult {
  /** true — текущее сообщение должно быть заблокировано (в т.ч. в cooldown). */
  blocked: boolean;
  /** Что именно сработало (для логов). */
  reason?: string;
  /** Если Redis недоступен — fail-open, поле true. */
  degraded: boolean;
}

/**
 * Антифлуд на двух сигналах:
 *
 * 1. **Burst** — плотность отправки. Если в последние `windowMs` мс было ≥ `messages`
 *    сообщений — блок и cooldown. Реализован через `ZSET` таймстампов.
 *
 * 2. **Repeat** — повторяемость. Если один и тот же нормализованный текст
 *    (или его near-duplicate prefix) встречается ≥ `occurrences` раз
 *    в последних `historySize` сообщениях — блок и cooldown.
 *    Реализован через `LIST` хешей.
 *
 * Оба чека дешёвые (1–3 Redis-ops). При недоступности Redis работают fail-open
 * (как и RateLimitService), чтобы не валить пайплайн.
 *
 * Ключи:
 *  - `safety:burst:{key}`           — ZSET (score = timestamp, member = ts)
 *  - `safety:burst-cd:{key}`        — STRING (cooldown sentinel, TTL)
 *  - `safety:repeat:{key}`          — LIST последних хешей (LPUSH + LTRIM)
 *  - `safety:repeat-cd:{key}`       — STRING (cooldown sentinel, TTL)
 */
@Injectable()
export class FloodProtectionService implements OnModuleDestroy {
  private readonly logger = new Logger(FloodProtectionService.name);
  private connection: IORedis | undefined;
  private warnedDegraded = false;

  async checkBurst(key: string, cfg: ResolvedBurstLimit): Promise<FloodCheckResult> {
    const redis = this.ensureConnection();
    if (!redis) {
      this.warnDegraded("no redis configured");
      return { blocked: false, degraded: true };
    }
    const cdKey = `safety:burst-cd:${key}`;
    const zKey = `safety:burst:${key}`;
    try {
      // Если ещё в cooldown — сразу блок (без зачисления нового события).
      const cd = await redis.exists(cdKey);
      if (cd > 0) {
        return { blocked: true, reason: "cooldown", degraded: false };
      }

      const now = Date.now();
      const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
      const cutoff = now - cfg.windowMs;

      // Чистим протухшие, добавляем текущее, считаем размер окна.
      const pipeline = redis.multi();
      pipeline.zremrangebyscore(zKey, "-inf", cutoff);
      pipeline.zadd(zKey, now, member);
      pipeline.zcount(zKey, cutoff, "+inf");
      // Чтобы ZSET не рос вечно у бездействующих юзеров.
      pipeline.pexpire(zKey, Math.max(cfg.windowMs * 4, 60_000));
      const results = (await pipeline.exec()) ?? [];

      const countEntry = results[2];
      const count = countEntry && countEntry[1] != null ? Number(countEntry[1]) : 0;

      if (count >= cfg.messages) {
        await redis.set(cdKey, "1", "EX", cfg.cooldownSeconds);
        return {
          blocked: true,
          reason: `${count}msg in ${cfg.windowMs}ms`,
          degraded: false,
        };
      }
      return { blocked: false, degraded: false };
    } catch (e) {
      this.warnDegraded(e instanceof Error ? e.message : String(e));
      return { blocked: false, degraded: true };
    }
  }

  async checkRepeat(
    key: string,
    text: string,
    cfg: ResolvedRepeatLimit,
  ): Promise<FloodCheckResult> {
    const redis = this.ensureConnection();
    if (!redis) {
      this.warnDegraded("no redis configured");
      return { blocked: false, degraded: true };
    }
    const cdKey = `safety:repeat-cd:${key}`;
    const listKey = `safety:repeat:${key}`;
    try {
      const cd = await redis.exists(cdKey);
      if (cd > 0) {
        return { blocked: true, reason: "cooldown", degraded: false };
      }

      const hash = this.hashFor(text, cfg.nearDuplicatePrefix);
      if (!hash) {
        // Пустой/whitespace-only текст — не считаем за повтор.
        return { blocked: false, degraded: false };
      }

      const history = cfg.historySize ?? 10;
      const pipeline = redis.multi();
      pipeline.lpush(listKey, hash);
      pipeline.ltrim(listKey, 0, history - 1);
      pipeline.expire(listKey, cfg.windowSeconds);
      pipeline.lrange(listKey, 0, history - 1);
      const results = (await pipeline.exec()) ?? [];

      const rangeEntry = results[3];
      const recent = (rangeEntry && rangeEntry[1]) as string[] | undefined;
      if (!Array.isArray(recent)) {
        return { blocked: false, degraded: false };
      }
      let matches = 0;
      for (const h of recent) {
        if (h === hash) matches++;
      }
      if (matches >= cfg.occurrences) {
        await redis.set(cdKey, "1", "EX", cfg.cooldownSeconds);
        return {
          blocked: true,
          reason: `${matches} repeats of "${hash}" in last ${recent.length}`,
          degraded: false,
        };
      }
      return { blocked: false, degraded: false };
    } catch (e) {
      this.warnDegraded(e instanceof Error ? e.message : String(e));
      return { blocked: false, degraded: true };
    }
  }

  /**
   * Нормализация: lower-case, schwa fold ё→е, collapse whitespace, trim,
   * затем (опц.) обрезка до prefix символов и SHA-1 (короткий).
   */
  hashFor(text: string, nearDuplicatePrefix?: number): string {
    const normalized = text.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    const slice =
      nearDuplicatePrefix && nearDuplicatePrefix > 0
        ? normalized.slice(0, nearDuplicatePrefix)
        : normalized;
    return createHash("sha1").update(slice).digest("base64url").slice(0, 16);
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
      this.logger.warn(`Flood protection degraded (fail-open): ${reason}`);
      this.warnedDegraded = true;
    }
  }
}
