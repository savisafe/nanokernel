import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(root, ".env") });

const cmd = process.argv[2];
const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;

async function api(method, body) {
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
    "Usage: node scripts/telegram-webhook.mjs <set|info|delete>\n" +
      "  set    — register TELEGRAM_WEBHOOK_URL with Telegram\n" +
      "  info   — current webhook and delivery errors\n" +
      "  delete — remove webhook (switch to long polling if you use it)",
  );
  process.exit(1);
}

async function main() {
  if (!["set", "info", "delete"].includes(cmd)) {
    usage();
  }
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set (check .env)");
    process.exit(1);
  }

  try {
    if (cmd === "set") {
      if (!webhookUrl) {
        console.error("TELEGRAM_WEBHOOK_URL is not set (check .env)");
        process.exit(1);
      }
      const { result, description } = await api("setWebhook", { url: webhookUrl });
      console.log(JSON.stringify({ ok: true, result, description }, null, 2));
    } else if (cmd === "info") {
      const data = await api("getWebhookInfo");
      console.log(JSON.stringify(data, null, 2));
    } else {
      const { result, description } = await api("deleteWebhook", {
        drop_pending_updates: false,
      });
      console.log(JSON.stringify({ ok: true, result, description }, null, 2));
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    if (e && typeof e === "object" && "data" in e && e.data) {
      console.error(JSON.stringify(e.data, null, 2));
    }
    process.exit(1);
  }
}

main();
