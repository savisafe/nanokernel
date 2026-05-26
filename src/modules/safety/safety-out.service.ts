import { Injectable, Logger } from "@nestjs/common";
import { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import { SafetyOutResult } from "./safety.types";

const DEFAULT_MAX_REPLY_CHARS = 4000;

/**
 * Минимальный post-filter LLM-ответа.
 *
 * Сейчас умеет только cap по длине. Fact-check (neverInvent против domain data) —
 * следующая итерация: требует знаний о всех источниках бота и нетривиальной проверки
 * числовых значений; warn-only без переспроса малопонятный сигнал, а действенный
 * перезапрос близок к Фазе 7.
 */
@Injectable()
export class SafetyOutService {
  private readonly logger = new Logger(SafetyOutService.name);

  apply(text: string, bot: ResolvedBotConfiguration): SafetyOutResult {
    const maxChars = bot.guardrails?.maxReplyChars ?? DEFAULT_MAX_REPLY_CHARS;
    if (text.length <= maxChars) {
      return { text, truncated: false, warnings: [] };
    }
    this.logger.warn(`safety-out cap bot=${bot.id} reply=${text.length}>maxChars=${maxChars}`);
    return {
      text: `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`,
      truncated: true,
      warnings: [`reply truncated from ${text.length} to ${maxChars} chars`],
    };
  }
}
