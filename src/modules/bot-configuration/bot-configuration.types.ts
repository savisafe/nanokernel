import type { PromptProfileFileJson } from "../prompt-profile/prompt-profile.types";
import type { DialogConfigFileJson } from "../dialog/dialog.config.types";
import type { SnippetSpec } from "../snippets/snippet.types";

export interface BotConfigurationFileJson {
  llmPromptProfile?: string | null;
  useRag?: boolean | string | null;
  promptProfile?: PromptProfileFileJson | null;
  dialog?: DialogConfigFileJson | null;
  snippets?: SnippetSpec[] | null;
}

export interface ResolvedBotLlmSettings {
  temperature?: number;
  maxTokens?: number;
}

export interface ResolvedBotConfiguration {
  id: string;
  llmPromptProfile: string;
  useRag: boolean;
  promptProfile?: PromptProfileFileJson;
  dialog?: DialogConfigFileJson;
  snippets?: SnippetSpec[];
  llm?: ResolvedBotLlmSettings;
}
