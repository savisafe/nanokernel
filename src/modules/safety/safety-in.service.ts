import { Injectable, Logger } from "@nestjs/common";
import { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import { getLanguagePack } from "../language/language-registry";
import type { LanguagePack, SafetyKeywordCategory } from "../language/language-pack.types";
import { RateLimitService } from "./rate-limit.service";
import { FloodProtectionService } from "./flood-protection.service";
import { SafetyCategory, SafetyInResult } from "./safety.types";

@Injectable()
export class SafetyInService {
  private readonly logger = new Logger(SafetyInService.name);
  // Скомпилированные injection-регексы, кешированные по коду языка (паттерны статичны
  // в пределах пака). Раньше компилировались один раз под единственный RU-набор.
  private readonly injectionRegexCache = new Map<string, RegExp[]>();

  constructor(
    private readonly rateLimit: RateLimitService,
    private readonly flood: FloodProtectionService,
  ) {}

  private langFor(bot: ResolvedBotConfiguration): LanguagePack {
    return getLanguagePack(bot.promptProfile?.language);
  }

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
    this.logger.warn(
      `rate-limit block bot=${bot.id} user=${externalUserId} limit=${cfg.requests}/${cfg.windowSeconds}s`,
    );
    return {
      blocked: true,
      category: "rate_limit",
      reply: bot.guardrails?.rateLimitReply ?? this.langFor(bot).refuseReplies.rate_limit,
      matched: `${cfg.requests}/${cfg.windowSeconds}s`,
    };
  }

  /**
   * Burst-чек: ловит резкие всплески (N сообщений за миллисекунды).
   * Дешёвый Redis-вызов, выполняется ДО content-safety и FSM.
   */
  async checkBurst(
    channel: string,
    externalUserId: string,
    bot: ResolvedBotConfiguration,
  ): Promise<SafetyInResult> {
    const cfg = bot.guardrails?.burstLimit;
    if (!cfg) {
      return { blocked: false };
    }
    const r = await this.flood.checkBurst(`${bot.id}:${channel}:${externalUserId}`, cfg);
    if (!r.blocked) {
      return { blocked: false };
    }
    this.logger.warn(`burst block bot=${bot.id} user=${externalUserId} reason="${r.reason}"`);
    return {
      blocked: true,
      category: "burst",
      reply: cfg.reply ?? this.langFor(bot).refuseReplies.burst,
      matched: r.reason,
      silent: cfg.silent ?? false,
    };
  }

  /**
   * Repeat-чек: ловит копипасту/повторяющийся мусор. Считает по нормализованному
   * хешу последних `historySize` сообщений.
   */
  async checkRepeat(
    channel: string,
    externalUserId: string,
    text: string,
    bot: ResolvedBotConfiguration,
  ): Promise<SafetyInResult> {
    const cfg = bot.guardrails?.repeatLimit;
    if (!cfg) {
      return { blocked: false };
    }
    const r = await this.flood.checkRepeat(`${bot.id}:${channel}:${externalUserId}`, text, cfg);
    if (!r.blocked) {
      return { blocked: false };
    }
    this.logger.warn(`repeat block bot=${bot.id} user=${externalUserId} reason="${r.reason}"`);
    return {
      blocked: true,
      category: "repeat",
      reply: cfg.reply ?? this.langFor(bot).refuseReplies.repeat,
      matched: r.reason,
      silent: cfg.silent ?? false,
    };
  }

  /** Проверка содержания: injection + safety topics (по opt-in списку). */
  checkContent(userText: string, bot: ResolvedBotConfiguration): SafetyInResult {
    const enabled = bot.guardrails?.safetyChecks ?? [];
    if (enabled.length === 0) {
      return { blocked: false };
    }
    const lang = this.langFor(bot);
    const normalized = lang.normalize(userText);

    if (enabled.includes("injection")) {
      const hit = this.findInjection(normalized, lang);
      if (hit) {
        return this.buildBlock("injection", hit, bot, lang);
      }
    }
    for (const category of enabled) {
      if (category === "injection") continue;
      const hit = this.findCategoryKeyword(normalized, category, lang);
      if (hit) {
        return this.buildBlock(category, hit, bot, lang);
      }
    }
    return { blocked: false };
  }

  private injectionRegexes(lang: LanguagePack): RegExp[] {
    let cached = this.injectionRegexCache.get(lang.code);
    if (!cached) {
      cached = lang.injectionPatterns.map((p) => new RegExp(p, "iu"));
      this.injectionRegexCache.set(lang.code, cached);
    }
    return cached;
  }

  private findInjection(text: string, lang: LanguagePack): string | undefined {
    for (const re of this.injectionRegexes(lang)) {
      const match = re.exec(text);
      if (match) {
        return match[0];
      }
    }
    return undefined;
  }

  private findCategoryKeyword(
    text: string,
    category: SafetyCategory,
    lang: LanguagePack,
  ): string | undefined {
    if (category === "injection") return undefined;
    const dict = lang.safetyKeywords[category as SafetyKeywordCategory];
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
    lang: LanguagePack,
  ): SafetyInResult {
    const reply = bot.guardrails?.refuseReply ?? lang.refuseReplies[category];
    this.logger.warn(`safety block bot=${bot.id} category=${category} matched="${matched}"`);
    return { blocked: true, category, reply, matched };
  }
}
