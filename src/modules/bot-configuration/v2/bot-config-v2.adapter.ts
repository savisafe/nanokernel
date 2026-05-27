import type { DialogConfigFileJson } from "../../dialog/dialog.config.types";
import type { PromptProfileFileJson } from "../../prompt-profile/prompt-profile.types";
import type { ResolvedBotConfiguration } from "../bot-configuration.types";
import type { BotConfigV2 } from "./bot-config-v2.types";
import { buildSystemPromptFromV2 } from "./system-prompt-builder";

/**
 * Преобразует v2 в текущий `ResolvedBotConfiguration`, ожидаемый pipeline (DialogService).
 *
 * v2 — это пользовательский фасад: декларативные поля persona/goals/guardrails/...
 * Внутренний пайплайн пока ничего не знает про v2 — он получает «short» dialog
 * с готовым `systemPrompt.template`, минимальный `promptProfile` и snippets.
 */
export function adaptV2ToResolved(id: string, v2: BotConfigV2): ResolvedBotConfiguration {
  const language = v2.persona.language ?? "ru";

  const promptProfile: PromptProfileFileJson = {
    companyName: v2.name,
    persona: v2.persona.role,
    language,
    humanLikeMode: v2.style?.humanLike ?? v2.persona.tone === "human" ? true : undefined,
    // template-режим игнорирует остальные поля promptProfile (см. DialogService),
    // но эти три используются для логов и общей идентификации профиля.
  };

  const dialog: DialogConfigFileJson = {
    systemPrompt: { template: buildSystemPromptFromV2(v2) },
    ...(v2.llm?.contextMessages !== undefined
      ? { contextMessages: v2.llm.contextMessages }
      : {}),
  };

  const llm =
    v2.llm?.temperature !== undefined || v2.llm?.maxTokens !== undefined
      ? {
          ...(v2.llm.temperature !== undefined ? { temperature: v2.llm.temperature } : {}),
          ...(v2.llm.maxTokens !== undefined ? { maxTokens: v2.llm.maxTokens } : {}),
        }
      : undefined;

  const guardrails =
    v2.guardrails &&
    (v2.guardrails.safetyChecks?.length ||
      v2.guardrails.refuseReply ||
      v2.guardrails.rateLimitReply ||
      v2.guardrails.llmFallbackReply ||
      v2.guardrails.rateLimit ||
      v2.guardrails.burstLimit ||
      v2.guardrails.repeatLimit ||
      v2.guardrails.maxReplyChars)
      ? {
          ...(v2.guardrails.safetyChecks?.length
            ? { safetyChecks: v2.guardrails.safetyChecks }
            : {}),
          ...(v2.guardrails.refuseReply ? { refuseReply: v2.guardrails.refuseReply } : {}),
          ...(v2.guardrails.rateLimitReply
            ? { rateLimitReply: v2.guardrails.rateLimitReply }
            : {}),
          ...(v2.guardrails.llmFallbackReply
            ? { llmFallbackReply: v2.guardrails.llmFallbackReply }
            : {}),
          ...(v2.guardrails.rateLimit ? { rateLimit: v2.guardrails.rateLimit } : {}),
          ...(v2.guardrails.burstLimit ? { burstLimit: v2.guardrails.burstLimit } : {}),
          ...(v2.guardrails.repeatLimit ? { repeatLimit: v2.guardrails.repeatLimit } : {}),
          ...(v2.guardrails.maxReplyChars !== undefined
            ? { maxReplyChars: v2.guardrails.maxReplyChars }
            : {}),
        }
      : undefined;

  const channel = v2.channel?.telegram
    ? { telegram: { ...v2.channel.telegram } }
    : undefined;

  return {
    id,
    llmPromptProfile: id,
    useRag: false,
    promptProfile,
    dialog,
    ...(v2.knowledge?.snippets && v2.knowledge.snippets.length > 0
      ? { snippets: v2.knowledge.snippets }
      : {}),
    ...(llm ? { llm } : {}),
    ...(v2.skills && v2.skills.length > 0 ? { skills: v2.skills } : {}),
    ...(v2.scripts && Object.keys(v2.scripts).length > 0 ? { scripts: v2.scripts } : {}),
    ...(guardrails ? { guardrails } : {}),
    ...(channel ? { channel } : {}),
  };
}
