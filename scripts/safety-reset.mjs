#!/usr/bin/env node
/**
 * Сбрасывает safety-state (rate-limit counters + burst/repeat cooldown sentinels
 * и истории) для всех пользователей или конкретного юзера.
 *
 * Использование:
 *   node scripts/safety-reset.mjs all
 *     — удалить ВСЕ ключи `safety:*` (все боты, все юзеры).
 *
 *   node scripts/safety-reset.mjs bot <bot-id>
 *     — только ключи конкретного бота (например, `daria-mokko`).
 *
 *   node scripts/safety-reset.mjs user <bot-id> <channel> <externalUserId>
 *     — только конкретный {bot,channel,user}. Channel обычно "telegram".
 *
 *   node scripts/safety-reset.mjs preview <pattern>
 *     — сухой прогон: показать, какие ключи матчатся (без удаления).
 *
 * Подключение к Redis через env: REDIS_HOST / REDIS_PORT / REDIS_PASSWORD
 * (те же, что и у приложения).
 */
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import IORedis from "ioredis";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(root, ".env") });

const [, , cmd, ...args] = process.argv;

function usage() {
  console.error(
    "Использование:\n" +
      "  safety-reset.mjs all\n" +
      "  safety-reset.mjs bot <bot-id>\n" +
      "  safety-reset.mjs user <bot-id> <channel> <externalUserId>\n" +
      "  safety-reset.mjs preview <pattern>",
  );
  process.exit(2);
}

function buildPattern() {
  switch (cmd) {
    case "all":
      return "safety:*";
    case "bot": {
      const botId = args[0];
      if (!botId) usage();
      // Все категории, в которых ключи `safety:<cat>:<botId>:*`.
      return `safety:*:${botId}:*`;
    }
    case "user": {
      const [botId, channel, userId] = args;
      if (!botId || !channel || !userId) usage();
      return `safety:*:${botId}:${channel}:${userId}`;
    }
    case "preview":
      if (!args[0]) usage();
      return args[0];
    default:
      usage();
  }
}

async function main() {
  const pattern = buildPattern();
  const dryRun = cmd === "preview";

  const redis = new IORedis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
    maxRetriesPerRequest: 2,
    connectTimeout: 2000,
  });

  try {
    const stream = redis.scanStream({ match: pattern, count: 200 });
    const matched = [];
    for await (const batch of stream) {
      for (const key of batch) matched.push(key);
    }

    if (matched.length === 0) {
      console.log(`No keys match: ${pattern}`);
      return;
    }

    console.log(`Matched ${matched.length} keys for pattern: ${pattern}`);
    for (const k of matched.slice(0, 30)) console.log(`  ${k}`);
    if (matched.length > 30) console.log(`  ... +${matched.length - 30} more`);

    if (dryRun) {
      console.log("(preview mode — nothing deleted)");
      return;
    }

    // Удаляем чанками, чтобы не упереться в Redis CLI arg limit.
    let deleted = 0;
    for (let i = 0; i < matched.length; i += 200) {
      const chunk = matched.slice(i, i + 200);
      const res = await redis.del(...chunk);
      deleted += res;
    }
    console.log(`Deleted ${deleted} keys.`);
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
