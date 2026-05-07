import type { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import type {
  DialogConfigMinimalFile,
  DialogServiceConfig,
  EffectiveDialogRuntime,
} from "./dialog.config.types";
import { DIALOG_SUBSYSTEM_DEFAULTS } from "./dialog-effective.defaults";

const DEFAULT_STAGE_FRAME: Pick<
  DialogServiceConfig["systemPromptFrame"],
  "openTopicsStageLine" | "funnelStageLineTemplate"
> = {
  openTopicsStageLine: "Режим: свободный диалог (без воронки продаж).",
  funnelStageLineTemplate: "Текущий этап воронки: {stage}.",
};

export function isLegacyDialogConfig(d: unknown): d is DialogServiceConfig {
  return (
    typeof d === "object" &&
    d !== null &&
    "staticPromptSuffix" in d &&
    typeof (d as DialogServiceConfig).staticPromptSuffix === "object" &&
    (d as DialogServiceConfig).staticPromptSuffix !== null
  );
}

export function resolveEffectiveDialog(bot: ResolvedBotConfiguration): EffectiveDialogRuntime {
  const raw = bot.dialog;
  if (!raw) {
    throw new Error(
      `Missing "dialog" in config/configurations/${bot.id}.json (see knowledge-consultant / open-topics).`,
    );
  }

  if (isLegacyDialogConfig(raw)) {
    const { systemPromptFrame, staticPromptSuffix, ...subsystem } = raw;
    return {
      systemKind: "legacy",
      systemPromptFrame,
      staticPromptSuffix,
      ...subsystem,
      telegramKnowledgeOnboarding: {
        ...DIALOG_SUBSYSTEM_DEFAULTS.telegramKnowledgeOnboarding,
        ...subsystem.telegramKnowledgeOnboarding,
      },
    };
  }

  const m = raw as DialogConfigMinimalFile;
  if (!m.systemPrompt?.template || typeof m.systemPrompt.template !== "string") {
    throw new Error(
      `dialog: для упрощённой сборки нужен object systemPrompt.template (configurations/${bot.id}.json).`,
    );
  }

  const base = structuredClone(DIALOG_SUBSYSTEM_DEFAULTS);
  if (typeof m.contextMessages === "number" && Number.isFinite(m.contextMessages)) {
    base.llmContextMessages = {
      ...base.llmContextMessages,
      defaultLimit: Math.min(50, Math.max(2, Math.floor(m.contextMessages))),
    };
  }
  if (m.templateStages) {
    base.templateStages = { ...base.templateStages, ...m.templateStages };
  }
  if (typeof m.fallbackNoKnowledgeReply === "string" && m.fallbackNoKnowledgeReply.trim()) {
    base.fallbackNoKnowledgeReply = m.fallbackNoKnowledgeReply.trim();
  }
  if (m.chunkDefaults) {
    base.chunkDefaults = { ...base.chunkDefaults, ...m.chunkDefaults };
  }
  if (m.chunkBoundaries) {
    base.chunkBoundaries = { ...base.chunkBoundaries, ...m.chunkBoundaries };
  }
  if (m.retrievalPresentation) {
    base.retrievalPresentation = { ...base.retrievalPresentation, ...m.retrievalPresentation };
  }
  if (m.tokenization) {
    base.tokenization = { ...base.tokenization, ...m.tokenization };
    if (m.tokenization.stopWords) {
      base.tokenization.stopWords = [...m.tokenization.stopWords];
    }
  }
  if (m.telegramKnowledgeOnboarding) {
    base.telegramKnowledgeOnboarding = {
      ...base.telegramKnowledgeOnboarding,
      ...m.telegramKnowledgeOnboarding,
    };
  }

  return {
    systemKind: "template",
    systemPromptTemplate: m.systemPrompt.template.trim(),
    stageFrame: { ...DEFAULT_STAGE_FRAME },
    ...base,
  };
}
