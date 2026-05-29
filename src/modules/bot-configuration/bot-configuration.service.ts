import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { ResolvedBotConfiguration } from "./bot-configuration.types";
import { adaptV2ToResolved } from "./v2/bot-config-v2.adapter";
import { botConfigV2Schema } from "./v2/bot-config-v2.types";
import { listBotConfigIds, resolveBotConfigFile } from "../shared/config-paths";

@Injectable()
export class BotConfigurationService implements OnModuleInit {
  private readonly logger = new Logger(BotConfigurationService.name);
  private readonly resolved: ResolvedBotConfiguration;
  private readonly resolveCache = new Map<string, ResolvedBotConfiguration>();
  private readonly bySecret = new Map<string, ResolvedBotConfiguration>();

  constructor() {
    const id = this.normalizeConfigurationId(process.env.BOT_CONFIGURATION?.trim() || "default");
    this.resolved = this.load(id);
    this.resolveCache.set(id, this.resolved);
    this.discoverAll();
  }

  private normalizeConfigurationId(raw: string): string {
    const t = raw.trim();
    if (t.length === 0) {
      return "default";
    }
    return /\.json$/i.test(t) ? t.slice(0, -5) : t;
  }

  onModuleInit(): void {
    this.logger.log(`Default bot configuration: "${this.resolved.id}"`);
    const ids = [...this.resolveCache.keys()];
    const withSecrets = [...this.bySecret.values()].map((b) => b.id);
    this.logger.log(
      `Discovered configurations: ${ids.length} (${ids.join(", ")}). With Telegram webhook secret: ${withSecrets.length} (${withSecrets.join(", ") || "none"}).`,
    );
  }

  get(): ResolvedBotConfiguration {
    return this.resolved;
  }

  resolveById(rawConfigurationId: string): ResolvedBotConfiguration {
    const id = this.normalizeConfigurationId(rawConfigurationId);
    const hit = this.resolveCache.get(id);
    if (hit) {
      return hit;
    }
    const loaded = this.load(id);
    this.resolveCache.set(id, loaded);
    this.indexSecret(loaded);
    return loaded;
  }

  /** Резолв бота по секрету из URL вебхука. Возвращает undefined если секрет неизвестен. */
  resolveByWebhookSecret(secret: string): ResolvedBotConfiguration | undefined {
    return this.bySecret.get(secret);
  }

  /** Все известные сборки (для админ-эндпоинтов, метрик и т.п.). */
  listAll(): ResolvedBotConfiguration[] {
    return [...this.resolveCache.values()];
  }

  private discoverAll(): void {
    const ids = listBotConfigIds();
    if (ids.length === 0) {
      this.logger.warn("No bot configurations discovered. Multi-bot routing disabled.");
      return;
    }
    for (const id of ids) {
      if (this.resolveCache.has(id)) {
        this.indexSecret(this.resolveCache.get(id)!);
        continue;
      }
      try {
        const bot = this.load(id);
        this.resolveCache.set(id, bot);
        this.indexSecret(bot);
      } catch (e) {
        this.logger.warn(
          `Configuration "${id}" failed to load during discovery: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  private indexSecret(bot: ResolvedBotConfiguration): void {
    const secret = bot.channel?.telegram?.webhookSecret;
    if (!secret) return;
    const existing = this.bySecret.get(secret);
    if (existing && existing.id !== bot.id) {
      this.logger.warn(
        `Webhook secret collision: "${existing.id}" and "${bot.id}" share the same secret — keeping "${existing.id}".`,
      );
      return;
    }
    this.bySecret.set(secret, bot);
  }

  /**
   * Загружает сборку. Поддерживает только BotConfig v2 (schemaVersion: 2).
   * Legacy формат (v1 promptProfile/dialog без schemaVersion) больше не парсится.
   */
  private load(configurationId: string): ResolvedBotConfiguration {
    const filePath = resolveBotConfigFile(configurationId);

    let raw: { schemaVersion?: number };
    try {
      const content = readFileSync(filePath, "utf8");
      raw = JSON.parse(content) as { schemaVersion?: number };
    } catch (e) {
      throw new Error(
        `Configuration "${configurationId}" not found or invalid (${filePath}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (raw.schemaVersion !== 2) {
      throw new Error(
        `Configuration "${configurationId}" must have schemaVersion: 2 (BotConfig v2). Legacy format is no longer supported.`,
      );
    }
    const parsed = botConfigV2Schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `BotConfig v2 invalid (${filePath}):\n${parsed.error.issues
          .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n")}`,
      );
    }
    return adaptV2ToResolved(configurationId, parsed.data);
  }
}
