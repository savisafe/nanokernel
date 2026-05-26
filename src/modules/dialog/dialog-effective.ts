import type { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import type {
  DialogConfigFileJson,
  EffectiveDialogRuntime,
} from "./dialog.config.types";
import { DIALOG_SUBSYSTEM_DEFAULTS } from "./dialog-effective.defaults";

const DEFAULT_STAGE_FRAME = {
  openTopicsStageLine: "Режим: свободный диалог.",
  funnelStageLineTemplate: "Текущий этап воронки: {stage}.",
};

export function resolveEffectiveDialog(bot: ResolvedBotConfiguration): EffectiveDialogRuntime {
  const raw = bot.dialog as DialogConfigFileJson | undefined;
  if (!raw) {
    // Конфиги v2 без явного dialog-блока — даём дефолты + пустой template
    // (адаптер v2 обязан сетить systemPrompt.template; если не сделал — упадём ниже).
    throw new Error(
      `Missing "dialog" for bot "${bot.id}" — BotConfig v2 adapter must populate dialog.systemPrompt.template.`,
    );
  }

  if (!raw.systemPrompt?.template || typeof raw.systemPrompt.template !== "string") {
    throw new Error(
      `dialog.systemPrompt.template is required (bot="${bot.id}").`,
    );
  }

  const base = structuredClone(DIALOG_SUBSYSTEM_DEFAULTS);

  if (typeof raw.contextMessages === "number" && Number.isFinite(raw.contextMessages)) {
    base.llmContextMessages = {
      ...base.llmContextMessages,
      defaultLimit: Math.min(50, Math.max(2, Math.floor(raw.contextMessages))),
    };
  }
  if (raw.templateStages) {
    base.templateStages = { ...base.templateStages, ...raw.templateStages };
  }
  if (typeof raw.fallbackNoKnowledgeReply === "string" && raw.fallbackNoKnowledgeReply.trim()) {
    base.fallbackNoKnowledgeReply = raw.fallbackNoKnowledgeReply.trim();
  }
  if (raw.chunkDefaults) {
    base.chunkDefaults = { ...base.chunkDefaults, ...raw.chunkDefaults };
  }
  if (raw.chunkBoundaries) {
    base.chunkBoundaries = { ...base.chunkBoundaries, ...raw.chunkBoundaries };
  }
  if (raw.retrievalPresentation) {
    base.retrievalPresentation = { ...base.retrievalPresentation, ...raw.retrievalPresentation };
  }
  if (raw.tokenization) {
    base.tokenization = { ...base.tokenization, ...raw.tokenization };
    if (raw.tokenization.stopWords) {
      base.tokenization.stopWords = [...raw.tokenization.stopWords];
    }
  }
  if (raw.telegramKnowledgeOnboarding) {
    base.telegramKnowledgeOnboarding = {
      ...base.telegramKnowledgeOnboarding,
      ...raw.telegramKnowledgeOnboarding,
    };
  }

  return {
    ...base,
    systemPromptTemplate: raw.systemPrompt.template.trim(),
    stageFrame: { ...DEFAULT_STAGE_FRAME },
  };
}
