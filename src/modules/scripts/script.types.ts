import type { Conversation } from "@prisma/client";
import type { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";

export type ScriptSlots = Record<string, string>;

export interface ScriptStepInput {
  conversation: Conversation;
  bot: ResolvedBotConfiguration;
  userText: string;
}

export type ScriptStepOutcome =
  | { handled: false }
  | {
      handled: true;
      reply: string;
      /** true — FSM завершилась (успех/отмена), state в БД уже сброшен. */
      terminal: boolean;
      /** Имя скрипта, который отработал (для observability). */
      scriptName: string;
    };

/** Префиксы состояний FSM. */
export const SCRIPT_STATE_SLOT_PREFIX = "slot:";
export const SCRIPT_STATE_CONFIRM = "confirm";
