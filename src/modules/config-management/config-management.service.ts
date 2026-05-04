import { Injectable, Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  BotConfigurationFileJson,
  ResolvedBotConfiguration,
} from "../bot-configuration/bot-configuration.types";
import { PromptProfileService } from "../prompt-profile/prompt-profile.service";
import { PromptProfileFileJson, ResolvedLlmPromptProfile } from "../prompt-profile/prompt-profile.types";
import { ResolvedDialogResourceBundle } from "./config-management.types";

type BundleCacheEntry = { expiresAt: number; value: ResolvedDialogResourceBundle };

@Injectable()
export class ConfigManagementService {
  private readonly logger = new Logger(ConfigManagementService.name);
  private readonly cache = new Map<string, BundleCacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly promptProfileService: PromptProfileService,
  ) {}

  invalidateCacheForConfiguration(configurationKey: string): void {
    this.cache.delete(`bundle:${configurationKey}`);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Разрешает сборку бота по id/slug строки в БД или, если записи нет, по имени файла config/configurations/<id>.json.
   * Профиль: сначала Prisma PromptProfile по slug = llmPromptProfile, иначе JSON с диска.
   */
  async resolveDialogResourceBundle(configurationId: string): Promise<ResolvedDialogResourceBundle> {
    const ttlMs = this.getCacheTtlMs();
    const cacheKey = `bundle:${configurationId}`;
    if (ttlMs > 0) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) {
        return hit.value;
      }
    }

    const { bot, raw } = await this.loadBotConfigurationPayload(configurationId);
    const profile = await this.resolvePromptProfile(bot.llmPromptProfile, raw);

    const bundle: ResolvedDialogResourceBundle = { bot, profile };
    if (ttlMs > 0) {
      this.cache.set(cacheKey, { expiresAt: Date.now() + ttlMs, value: bundle });
    }
    return bundle;
  }

  private getCacheTtlMs(): number {
    const raw = process.env.CONFIG_MGMT_CACHE_TTL_MS?.trim();
    if (!raw) {
      return 0;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return 0;
    }
    return Math.min(300_000, Math.floor(n));
  }

  private async loadBotConfigurationPayload(
    configurationId: string,
  ): Promise<{ bot: ResolvedBotConfiguration; raw: BotConfigurationFileJson }> {
    const row = await this.prisma.botConfiguration.findFirst({
      where: { OR: [{ id: configurationId }, { slug: configurationId }] },
    });
    if (row) {
      const raw = this.asJsonObject(row.data) as BotConfigurationFileJson;
      const bot = this.resolveBotFields(raw, row.id);
      return { bot, raw };
    }
    return { bot: this.loadBotFromFilesystem(configurationId), raw: this.readBotJsonFile(configurationId) };
  }

  private readBotJsonFile(configurationId: string): BotConfigurationFileJson {
    const filePath = path.resolve(process.cwd(), "config", "configurations", `${configurationId}.json`);
    try {
      const content = readFileSync(filePath, "utf8");
      return JSON.parse(content) as BotConfigurationFileJson;
    } catch (e) {
      this.logger.warn(
        `Bot configuration file missing (${filePath}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return {};
    }
  }

  private loadBotFromFilesystem(configurationId: string): ResolvedBotConfiguration {
    const raw = this.readBotJsonFile(configurationId);
    return this.resolveBotFields(raw, configurationId);
  }

  private resolveBotFields(
    raw: BotConfigurationFileJson,
    /** Slug файла конфигурации или id строки в БД */
    resolvedId: string,
  ): ResolvedBotConfiguration {
    const llmPromptProfile =
      (typeof raw.llmPromptProfile === "string" && raw.llmPromptProfile.trim().length > 0
        ? raw.llmPromptProfile.trim()
        : undefined) ??
      process.env.LLM_PROMPT_PROFILE?.trim() ??
      "default";

    const rawUseRag = raw.useRag;
    const useRag =
      rawUseRag === true || (typeof rawUseRag === "string" && rawUseRag.trim().toLowerCase() === "true");

    const embedded =
      raw.promptProfile && typeof raw.promptProfile === "object" && !Array.isArray(raw.promptProfile)
        ? (raw.promptProfile as PromptProfileFileJson)
        : undefined;

    return {
      id: resolvedId,
      llmPromptProfile,
      useRag,
      ...(embedded ? { promptProfile: embedded } : {}),
    };
  }

  private async resolvePromptProfile(
    profileSlug: string,
    botRaw: BotConfigurationFileJson,
  ): Promise<ResolvedLlmPromptProfile> {
    const embedded = botRaw.promptProfile;
    if (embedded && typeof embedded === "object" && !Array.isArray(embedded)) {
      return this.promptProfileService.resolveFromPromptProfileJson(profileSlug, embedded);
    }
    const row = await this.prisma.promptProfile.findUnique({ where: { slug: profileSlug } });
    if (row) {
      const raw = this.asJsonObject(row.data) as PromptProfileFileJson;
      return this.promptProfileService.resolveFromPromptProfileJson(profileSlug, raw);
    }
    return this.promptProfileService.resolveProfileFromFilesystem(profileSlug);
  }

  private asJsonObject(value: Prisma.JsonValue): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }
}
