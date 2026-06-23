import IORedis from "ioredis";

/**
 * Отдельное соединение на клиент очереди / воркер (BullMQ не рекомендует один ioredis на всё).
 * maxRetriesPerRequest: null — требование BullMQ для блокирующих команд воркера.
 */
export function createRedisConnectionForBullmq(): IORedis {
  const host = process.env.REDIS_HOST ?? "localhost";
  const port = Number(process.env.REDIS_PORT ?? 6379);
  const password = process.env.REDIS_PASSWORD;

  return new IORedis({
    host,
    port,
    ...(password ? { password } : {}),
    maxRetriesPerRequest: null,
  });
}
