import type { PromptProfileFileJson } from "../prompt-profile/prompt-profile.types";
import type { DialogServiceConfig } from "../dialog/dialog.config.types";

export interface BotConfigurationFileJson {
  llmPromptProfile?: string | null;
  useRag?: boolean | string | null;
  promptProfile?: PromptProfileFileJson | null;
  dialog?: DialogServiceConfig | null;
}

export interface ResolvedBotConfiguration {
  id: string;
  llmPromptProfile: string;
  useRag: boolean;
  promptProfile?: PromptProfileFileJson;
  dialog?: DialogServiceConfig;
}
