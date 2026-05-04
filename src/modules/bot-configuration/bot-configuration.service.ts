import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PromptProfileFileJson } from "../prompt-profile/prompt-profile.types";
import type { DialogServiceConfig } from "../dialog/dialog.config.types";
import {
  BotConfigurationFileJson,
  ResolvedBotConfiguration,
} from "./bot-configuration.types";

@Injectable()
export class BotConfigurationService implements OnModuleInit {
  private readonly logger = new Logger(BotConfigurationService.name);
  private readonly resolved: ResolvedBotConfiguration;

  constructor() {
    const id = process.env.BOT_CONFIGURATION?.trim() || "default";
    this.resolved = this.load(id);
  }

  onModuleInit(): void {
    this.logger.log(
      `Bot configuration "${this.resolved.id}" → promptProfile="${this.resolved.llmPromptProfile}", useRag=${this.resolved.useRag}`,
    );
  }

  get(): ResolvedBotConfiguration {
    return this.resolved;
  }

  private load(configurationId: string): ResolvedBotConfiguration {
    const filePath = path.resolve(
      process.cwd(),
      "config",
      "configurations",
      `${configurationId}.json`,
    );

    let raw: BotConfigurationFileJson = {};
    try {
      const content = readFileSync(filePath, "utf8");
      raw = JSON.parse(content) as BotConfigurationFileJson;
    } catch (e) {
      this.logger.warn(
        `Configuration file missing or invalid (${filePath}), using env/default paths: ${e instanceof Error ? e.message : String(e)}`,
      );
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

    return {
      id: configurationId,
      llmPromptProfile,
      useRag,
      ...(promptProfile ? { promptProfile } : {}),
      ...(dialog ? { dialog } : {}),
    };
  }

  private extractDialog(value: BotConfigurationFileJson["dialog"]): DialogServiceConfig | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value as DialogServiceConfig;
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
