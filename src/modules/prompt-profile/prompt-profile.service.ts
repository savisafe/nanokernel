import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BotConfigurationService } from "../bot-configuration/bot-configuration.service";
import type { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import { PromptProfileFileJson, ResolvedLlmPromptProfile } from "./prompt-profile.types";
import {
  DEFAULT_STRICT_KNOWLEDGE_CONVERSATIONAL_MAX_LENGTH,
  DEFAULT_STRICT_KNOWLEDGE_CONVERSATIONAL_PATTERNS,
} from "./strict-knowledge-conversational.defaults";

@Injectable()
export class PromptProfileService implements OnModuleInit {
  private readonly logger = new Logger(PromptProfileService.name);
  private profile!: ResolvedLlmPromptProfile;

  constructor(private readonly botConfiguration: BotConfigurationService) {}

  onModuleInit(): void {
    const bot = this.botConfiguration.get();
    const id = bot.llmPromptProfile;
    this.profile = this.loadResolvedProfile(id, bot);
    this.logger.log(
      `LLM prompt profile "${this.profile.id}" (company="${this.profile.companyName}"${this.profile.humanLikeMode ? ", human-like mode" : ""}${this.profile.openTopicsMode ? ", open topics" : ""})`,
    );
  }

  getProfile(): ResolvedLlmPromptProfile {
    return this.profile;
  }

  resolveProfileFromFilesystem(profileId: string): ResolvedLlmPromptProfile {
    const filePath = path.resolve(process.cwd(), "config", "prompt-profiles", `${profileId}.json`);
    try {
      const content = readFileSync(filePath, "utf8");
      const raw = JSON.parse(content) as PromptProfileFileJson;
      return this.resolveFromPromptProfileJson(profileId, raw);
    } catch (e) {
      this.logger.warn(
        `Prompt profile file missing or invalid (${filePath}), using minimal fallback: ${e instanceof Error ? e.message : String(e)}`,
      );
      return this.fallbackProfile(profileId);
    }
  }

  resolveFromPromptProfileJson(profileId: string, raw: PromptProfileFileJson): ResolvedLlmPromptProfile {
    const topic = typeof raw.topic === "string" ? raw.topic.trim() : undefined;
    const forbiddenTopics = Array.isArray(raw.forbiddenTopics)
      ? raw.forbiddenTopics.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const neverDo = Array.isArray(raw.neverDo)
      ? raw.neverDo.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const primaryGoals = Array.isArray(raw.primaryGoals)
      ? raw.primaryGoals.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const additionalStyleRules = Array.isArray(raw.additionalStyleRules)
      ? raw.additionalStyleRules.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const companyName =
      typeof raw.companyName === "string" && raw.companyName.trim().length > 0
        ? raw.companyName.trim()
        : "компании";
    const persona =
      typeof raw.persona === "string" && raw.persona.trim().length > 0 ? raw.persona.trim() : undefined;
    const language =
      typeof raw.language === "string" && raw.language.trim().length > 0
        ? raw.language.trim()
        : undefined;
    const servicesHighlight =
      typeof raw.servicesHighlight === "string" && raw.servicesHighlight.trim().length > 0
        ? raw.servicesHighlight.trim()
        : undefined;
    const bookingAndContact =
      typeof raw.bookingAndContact === "string" && raw.bookingAndContact.trim().length > 0
        ? raw.bookingAndContact.trim()
        : undefined;

    const rawHuman = raw.humanLikeMode;
    const humanLikeMode =
      rawHuman === true ||
      (typeof rawHuman === "string" && rawHuman.trim().toLowerCase() === "true");

    const rawOpen = raw.openTopicsMode;
    const openTopicsMode =
      rawOpen === true ||
      (typeof rawOpen === "string" && rawOpen.trim().toLowerCase() === "true");
    const rawStrict = raw.strictKnowledgeMode;
    const strictKnowledgeMode =
      rawStrict === true ||
      (typeof rawStrict === "string" && rawStrict.trim().toLowerCase() === "true");
    const noKnowledgeReply =
      typeof raw.noKnowledgeReply === "string" && raw.noKnowledgeReply.trim().length > 0
        ? raw.noKnowledgeReply.trim()
        : undefined;
    const retrievalChunkSize = this.parseIntInRange(raw.retrievalChunkSize, 200, 8000);
    const retrievalChunkOverlap = this.parseIntInRange(raw.retrievalChunkOverlap, 0, 1000);
    const retrievalTopK = this.parseIntInRange(raw.retrievalTopK, 1, 20);

    let scopeText: string | undefined;
    if (typeof raw.scopeText === "string" && raw.scopeText.trim().length > 0) {
      scopeText = raw.scopeText.trim();
    } else if (typeof raw.scopeFile === "string" && raw.scopeFile.trim().length > 0) {
      scopeText = this.readScopeFile(raw.scopeFile.trim()) ?? undefined;
    }

    let strictKnowledgeConversationalBypass: ResolvedLlmPromptProfile["strictKnowledgeConversationalBypass"];
    let strictKnowledgeConversationalPromptAddendumLines: string[] | undefined;
    if (strictKnowledgeMode) {
      const rawBypass = raw.strictKnowledgeConversationalBypass;
      if (rawBypass === undefined || rawBypass === null) {
        strictKnowledgeConversationalBypass = {
          maxMessageLength: DEFAULT_STRICT_KNOWLEDGE_CONVERSATIONAL_MAX_LENGTH,
          patterns: [...DEFAULT_STRICT_KNOWLEDGE_CONVERSATIONAL_PATTERNS],
        };
      } else {
        const maxRaw = rawBypass.maxMessageLength;
        const maxMessageLength =
          this.parseIntInRange(maxRaw, 20, 2000) ?? DEFAULT_STRICT_KNOWLEDGE_CONVERSATIONAL_MAX_LENGTH;
        const patternsKey = rawBypass.patterns;
        if (patternsKey === undefined) {
          strictKnowledgeConversationalBypass = {
            maxMessageLength,
            patterns: [...DEFAULT_STRICT_KNOWLEDGE_CONVERSATIONAL_PATTERNS],
          };
        } else if (!Array.isArray(patternsKey)) {
          strictKnowledgeConversationalBypass = {
            maxMessageLength,
            patterns: [...DEFAULT_STRICT_KNOWLEDGE_CONVERSATIONAL_PATTERNS],
          };
        } else if (patternsKey.length === 0) {
          strictKnowledgeConversationalBypass = { maxMessageLength, patterns: [] };
        } else {
          const patterns: RegExp[] = [];
          for (const src of patternsKey.map((s) => String(s).trim()).filter(Boolean)) {
            try {
              patterns.push(new RegExp(src, "u"));
            } catch (e) {
              this.logger.warn(
                `strictKnowledgeConversationalBypass: invalid regex skipped: ${src} (${e instanceof Error ? e.message : String(e)})`,
              );
            }
          }
          strictKnowledgeConversationalBypass = { maxMessageLength, patterns };
        }
      }

      const rawAddendum = raw.strictKnowledgeConversationalPromptAddendum;
      if (rawAddendum === undefined || rawAddendum === null) {
        strictKnowledgeConversationalPromptAddendumLines = undefined;
      } else if (Array.isArray(rawAddendum)) {
        strictKnowledgeConversationalPromptAddendumLines = rawAddendum.map((s) => String(s));
      }
    }

    return {
      id: profileId,
      companyName,
      persona,
      language,
      primaryGoals: primaryGoals.length > 0 ? primaryGoals : undefined,
      topic: topic && topic.length > 0 ? topic : undefined,
      servicesHighlight,
      forbiddenTopics,
      neverDo: neverDo.length > 0 ? neverDo : undefined,
      bookingAndContact,
      additionalStyleRules: additionalStyleRules.length > 0 ? additionalStyleRules : undefined,
      humanLikeMode: humanLikeMode ? true : undefined,
      openTopicsMode: openTopicsMode ? true : undefined,
      scopeText,
      strictKnowledgeMode: strictKnowledgeMode ? true : undefined,
      noKnowledgeReply,
      retrievalChunkSize,
      retrievalChunkOverlap,
      retrievalTopK,
      strictKnowledgeConversationalBypass,
      strictKnowledgeConversationalPromptAddendumLines,
    };
  }

  private loadResolvedProfile(
    profileId: string,
    bot: ResolvedBotConfiguration,
  ): ResolvedLlmPromptProfile {
    if (bot.promptProfile) {
      return this.resolveFromPromptProfileJson(profileId, bot.promptProfile);
    }
    return this.resolveProfileFromFilesystem(profileId);
  }

  private readScopeFile(relativeOrAbsolute: string): string | null {
    try {
      const abs = path.isAbsolute(relativeOrAbsolute)
        ? relativeOrAbsolute
        : path.resolve(process.cwd(), relativeOrAbsolute);
      const text = readFileSync(abs, "utf8").trim();
      return text.length > 0 ? text : null;
    } catch (e) {
      this.logger.warn(
        `scopeFile not read (${relativeOrAbsolute}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  private fallbackProfile(profileId: string): ResolvedLlmPromptProfile {
    return {
      id: profileId,
      companyName: "компании",
      forbiddenTopics: [],
    };
  }

  private parseIntInRange(
    value: number | string | null | undefined,
    min: number,
    max: number,
  ): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) {
      return undefined;
    }
    const rounded = Math.floor(n);
    if (rounded < min || rounded > max) {
      return undefined;
    }
    return rounded;
  }
}
