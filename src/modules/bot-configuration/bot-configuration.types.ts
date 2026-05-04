import type { PromptProfileFileJson } from "../prompt-profile/prompt-profile.types";

export interface BotConfigurationFileJson {
  llmPromptProfile?: string | null;
  useRag?: boolean | string | null;
  promptProfile?: PromptProfileFileJson | null;
}

export interface ResolvedBotConfiguration {
  id: string;
  llmPromptProfile: string;
  useRag: boolean;
  promptProfile?: PromptProfileFileJson;
}
