import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PromptProfileFileJson } from "../prompt-profile/prompt-profile.types";
import type { DialogConfigFileJson } from "../dialog/dialog.config.types";
import type { SnippetSpec } from "../snippets/snippet.types";
import {
  BotConfigurationFileJson,
  ResolvedBotConfiguration,
} from "./bot-configuration.types";
import { adaptV2ToResolved } from "./v2/bot-config-v2.adapter";
import { botConfigV2Schema } from "./v2/bot-config-v2.types";

@Injectable()
export class BotConfigurationService implements OnModuleInit {
  private readonly logger = new Logger(BotConfigurationService.name);
  private readonly resolved: ResolvedBotConfiguration;
  private readonly resolveCache = new Map<string, ResolvedBotConfiguration>();

  constructor() {
    const id = this.normalizeConfigurationId(process.env.BOT_CONFIGURATION?.trim() || "default");
    this.resolved = this.load(id);
    this.resolveCache.set(id, this.resolved);
  }

  private normalizeConfigurationId(raw: string): string {
    const t = raw.trim();
    if (t.length === 0) {
      return "default";
    }
    return /\.json$/i.test(t) ? t.slice(0, -5) : t;
  }

  onModuleInit(): void {
    this.logger.log(
      `Bot configuration "${this.resolved.id}" → promptProfile="${this.resolved.llmPromptProfile}", useRag=${this.resolved.useRag}`,
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
    return loaded;
  }

  private load(configurationId: string): ResolvedBotConfiguration {
    const filePath = path.resolve(
      process.cwd(),
      "config",
      "configurations",
      `${configurationId}.json`,
    );

    let raw: BotConfigurationFileJson & { schemaVersion?: number } = {};
    try {
      const content = readFileSync(filePath, "utf8");
      raw = JSON.parse(content) as BotConfigurationFileJson & { schemaVersion?: number };
    } catch (e) {
      this.logger.warn(
        `Configuration file missing or invalid (${filePath}), using env/default paths: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (raw.schemaVersion === 2) {
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

    const llmPromptProfile =
      (typeof raw.llmPromptProfile === "string" && raw.llmPromptProfile.trim().length > 0
        ? raw.llmPromptProfile.trim()
        : undefined) ??
      process.env.LLM_PROMPT_PROFILE?.trim() ??
      "default";

    const rawUseRag = raw.useRag;
    const useRag =
      rawUseRag === true ||
      (typeof rawUseRag === "string" && rawUseRag.trim().toLowerCase() === "true");

    const promptProfile = this.extractEmbeddedPromptProfile(raw.promptProfile);
    const dialog = this.extractDialog(raw.dialog);
    const snippets = this.extractSnippets(raw.snippets);

    return {
      id: configurationId,
      llmPromptProfile,
      useRag,
      ...(promptProfile ? { promptProfile } : {}),
      ...(dialog ? { dialog } : {}),
      ...(snippets ? { snippets } : {}),
    };
  }

  private extractSnippets(value: BotConfigurationFileJson["snippets"]): SnippetSpec[] | undefined {
    if (!Array.isArray(value) || value.length === 0) {
      return undefined;
    }
    const filtered: SnippetSpec[] = [];
    for (const item of value) {
      if (
        item &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        typeof item.reply === "string" &&
        Array.isArray(item.match) &&
        (item.mode === "exact" || item.mode === "regex" || item.mode === "keywords")
      ) {
        filtered.push(item);
      }
    }
    return filtered.length > 0 ? filtered : undefined;
  }

  private extractDialog(value: BotConfigurationFileJson["dialog"]): DialogConfigFileJson | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value as DialogConfigFileJson;
  }

  private extractEmbeddedPromptProfile(
    value: BotConfigurationFileJson["promptProfile"],
  ): PromptProfileFileJson | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value as PromptProfileFileJson;
  }
}
