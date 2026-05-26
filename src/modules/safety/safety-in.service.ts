import { Injectable, Logger } from "@nestjs/common";
import { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import { RateLimitService } from "./rate-limit.service";
import { INJECTION_PATTERNS } from "./injection-patterns";
import { SAFETY_KEYWORDS } from "./safety-keywords";
import { DEFAULT_REFUSE_REPLIES, SafetyCategory, SafetyInResult } from "./safety.types";

@Injectable()
export class SafetyInService {
  private readonly logger = new Logger(SafetyInService.name);
  // Скомпилированные регексы — общие на процесс (паттерны статичны).
  private readonly injectionRegexes: RegExp[] = INJECTION_PATTERNS.map(
    (p) => new RegExp(p, "iu"),
  );

  constructor(private readonly rateLimit: RateLimitService) {}

  /**
   * Rate-limit проверяется отдельно от topic/injection, потому что обычно нужен
   * ДО записи входящего сообщения в БД (защита от спама).
   */
  async checkRateLimit(
    channel: string,
    externalUserId: string,
    bot: ResolvedBotConfiguration,
  ): Promise<SafetyInResult> {
    const cfg = bot.guardrails?.rateLimit;
    if (!cfg) {
      return { blocked: false };
    }
    const r = await this.rateLimit.check(
      `${bot.id}:${channel}:${externalUserId}`,
      cfg.requests,
      cfg.windowSeconds,
    );
    if (r.allowed) {
      return { blocked: false };
    }
    return {
      blocked: true,
      category: "rate_limit",
      reply: bot.guardrails?.rateLimitReply ?? DEFAULT_REFUSE_REPLIES.rate_limit,
      matched: `${cfg.requests}/${cfg.windowSeconds}s`,
    };
  }

  /** Проверка содержания: injection + safety topics (по opt-in списку). */
  checkContent(userText: string, bot: ResolvedBotConfiguration): SafetyInResult {
    const enabled = bot.guardrails?.safetyChecks ?? [];
    if (enabled.length === 0) {
      return { blocked: false };
    }
    const normalized = userText.toLowerCase().replace(/ё/g, "е");

    if (enabled.includes("injection")) {
      const hit = this.findInjection(normalized);
      if (hit) {
        return this.buildBlock("injection", hit, bot);
      }
    }
    for (const category of enabled) {
      if (category === "injection") continue;
      const hit = this.findCategoryKeyword(normalized, category);
      if (hit) {
        return this.buildBlock(category, hit, bot);
      }
    }
    return { blocked: false };
  }

  private findInjection(text: string): string | undefined {
    for (const re of this.injectionRegexes) {
      const match = re.exec(text);
      if (match) {
        return match[0];
      }
    }
    return undefined;
  }

  private findCategoryKeyword(text: string, category: SafetyCategory): string | undefined {
    if (category === "injection") return undefined;
    const dict = SAFETY_KEYWORDS[category];
    if (!dict) return undefined;
    for (const kw of dict) {
      if (text.includes(kw)) {
        return kw;
      }
    }
    return undefined;
  }

  private buildBlock(
    category: SafetyCategory,
    matched: string,
    bot: ResolvedBotConfiguration,
  ): SafetyInResult {
    const reply = bot.guardrails?.refuseReply ?? DEFAULT_REFUSE_REPLIES[category];
    this.logger.warn(`safety block bot=${bot.id} category=${category} matched="${matched}"`);
    return { blocked: true, category, reply, matched };
  }
}
