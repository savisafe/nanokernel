import { config } from "dotenv";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(root, ".env") });

const cmd = process.argv[2];
const botArg = process.argv[3];
const baseUrl = process.env.TELEGRAM_WEBHOOK_BASE_URL ?? process.env.TELEGRAM_WEBHOOK_URL;

/**
 * Multi-bot режим (рекомендуемый): TELEGRAM_WEBHOOK_BASE_URL=https://yourdomain.com.
 * Для каждой сборки config/configurations/<id>.json с channel.telegram.{tokenEnv,webhookSecret}
 * этот скрипт построит {baseUrl}/webhooks/telegram/<secret> и зарегистрирует его.
 *
 * Legacy (один бот): TELEGRAM_WEBHOOK_URL=https://yourdomain.com/webhooks/telegram +
 * TELEGRAM_BOT_TOKEN в env. Этот путь используется когда в конфигах нет channel.telegram.
 */
function discoverBots() {
  const dir = join(root, "config", "configurations");
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (e) {
    console.error(`Cannot read ${dir}: ${e.message}`);
    return [];
  }
  for (const f of entries) {
    const id = f.slice(0, -5);
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const tg = raw?.channel?.telegram;
      if (!tg?.tokenEnv || !tg?.webhookSecret) continue;
      const token = process.env[tg.tokenEnv];
      out.push({
        id,
        tokenEnv: tg.tokenEnv,
        token,
        webhookSecret: tg.webhookSecret,
        apiSecretToken: tg.apiSecretToken,
      });
    } catch (e) {
      console.error(`Skip ${id}: ${e.message}`);
    }
  }
  return out;
}

async function api(token, method, body) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const init =
    body !== undefined
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { method: "GET" };
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(
      typeof data.description === "string" ? data.description : `HTTP ${res.status}`,
    );
    err.data = data;
    throw err;
  }
  return data;
}

function usage() {
  console.error(
    "Usage:\n" +
      "  node scripts/telegram-webhook.mjs <set|info|delete> [<bot-id>]\n\n" +
      "  set [<bot-id>]    — register webhook for one or all multi-bot configs\n" +
      "  info [<bot-id>]   — current webhook(s) and delivery errors\n" +
      "  delete [<bot-id>] — remove webhook(s)\n\n" +
      "Multi-bot env: TELEGRAM_WEBHOOK_BASE_URL=https://yourdomain.com\n" +
      "  + per-bot tokens via env vars referenced by channel.telegram.tokenEnv\n\n" +
      "Legacy env: TELEGRAM_WEBHOOK_URL=https://yourdomain.com/webhooks/telegram\n" +
      "  + TELEGRAM_BOT_TOKEN (used when no multi-bot configs exist)",
  );
  process.exit(1);
}

async function runForBot(bot, command) {
  if (!bot.token) {
    console.error(`  [${bot.id}] env ${bot.tokenEnv} is empty — skip`);
    return;
  }
  if (command === "set") {
    if (!baseUrl) {
      console.error(`  [${bot.id}] TELEGRAM_WEBHOOK_BASE_URL not set — skip`);
      return;
    }
    const url = `${baseUrl.replace(/\/$/, "")}/webhooks/telegram/${bot.webhookSecret}`;
    const body = { url };
    if (bot.apiSecretToken) body.secret_token = bot.apiSecretToken;
    const data = await api(bot.token, "setWebhook", body);
    console.log(`  [${bot.id}] set → ${url} (${data.description ?? "ok"})`);
  } else if (command === "info") {
    const data = await api(bot.token, "getWebhookInfo");
    console.log(`  [${bot.id}]`, JSON.stringify(data.result, null, 2));
  } else if (command === "delete") {
    const data = await api(bot.token, "deleteWebhook", { drop_pending_updates: false });
    console.log(`  [${bot.id}] delete → ${data.description ?? "ok"}`);
  }
}

async function runLegacy(command) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("No multi-bot configs with channel.telegram, and TELEGRAM_BOT_TOKEN is not set.");
    process.exit(1);
  }
  if (command === "set") {
    if (!baseUrl) {
      console.error("TELEGRAM_WEBHOOK_URL (or TELEGRAM_WEBHOOK_BASE_URL) is not set");
      process.exit(1);
    }
    const url = baseUrl.includes("/webhooks/telegram") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/webhooks/telegram`;
    const data = await api(token, "setWebhook", { url });
    console.log(`[legacy] set → ${url} (${data.description ?? "ok"})`);
  } else if (command === "info") {
    const data = await api(token, "getWebhookInfo");
    console.log(`[legacy]`, JSON.stringify(data.result, null, 2));
  } else if (command === "delete") {
    const data = await api(token, "deleteWebhook", { drop_pending_updates: false });
    console.log(`[legacy] delete → ${data.description ?? "ok"}`);
  }
}

async function main() {
  if (!["set", "info", "delete"].includes(cmd)) {
    usage();
  }

  const bots = discoverBots();
  const filtered = botArg ? bots.filter((b) => b.id === botArg) : bots;

  if (botArg && filtered.length === 0) {
    console.error(`Bot "${botArg}" not found or has no channel.telegram.`);
    process.exit(1);
  }

  if (filtered.length === 0) {
    // No multi-bot configs at all → fall through to legacy.
    await runLegacy(cmd);
    return;
  }

  console.log(`${cmd} for ${filtered.length} bot(s):`);
  for (const bot of filtered) {
    try {
      await runForBot(bot, cmd);
    } catch (e) {
      console.error(`  [${bot.id}] ERROR: ${e.message}`);
    }
  }
}

main();
