import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { BotUsageKind, BotUsageLlmTokens, BotUsageSummary } from "./bot-usage.types";

@Injectable()
export class BotUsageService {
  private readonly logger = new Logger(BotUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordSnippet(botId: string, conversationId: string, snippetId: string): Promise<void> {
    await this.safeCreate({
      botId,
      conversationId,
      kind: "snippet",
      snippetId,
    });
  }

  async recordLlm(
    botId: string,
    conversationId: string,
    usage?: BotUsageLlmTokens,
    model?: string,
  ): Promise<void> {
    await this.safeCreate({
      botId,
      conversationId,
      kind: "llm",
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      model,
    });
  }

  async recordNoLlmFallback(botId: string, conversationId: string): Promise<void> {
    await this.safeCreate({
      botId,
      conversationId,
      kind: "no_llm_fallback",
    });
  }

  async recordFsm(botId: string, conversationId: string, scriptName: string): Promise<void> {
    await this.safeCreate({
      botId,
      conversationId,
      kind: "fsm",
      snippetId: scriptName,
    });
  }

  /** Сводка за последние N часов; если botId не задан — по всем. */
  async summarize(options: { botId?: string; sinceHours?: number } = {}): Promise<BotUsageSummary> {
    const sinceHours = options.sinceHours ?? 24;
    const since = new Date(Date.now() - sinceHours * 3600_000);
    const where = {
      createdAt: { gte: since },
      ...(options.botId ? { botId: options.botId } : {}),
    };
    const rows = await this.prisma.botUsage.findMany({ where });

    const summary: BotUsageSummary = {
      total: rows.length,
      byKind: { snippet: 0, llm: 0, no_llm_fallback: 0, fsm: 0 },
      promptTokens: 0,
      completionTokens: 0,
      zeroTokenReplies: 0,
    };
    for (const r of rows) {
      const kind = r.kind as BotUsageKind;
      if (kind in summary.byKind) {
        summary.byKind[kind] += 1;
      }
      if (kind === "snippet" || kind === "no_llm_fallback" || kind === "fsm") {
        summary.zeroTokenReplies += 1;
      }
      if (typeof r.promptTokens === "number") {
        summary.promptTokens += r.promptTokens;
      }
      if (typeof r.completionTokens === "number") {
        summary.completionTokens += r.completionTokens;
      }
    }
    return summary;
  }

  private async safeCreate(data: {
    botId: string;
    conversationId?: string;
    kind: BotUsageKind;
    snippetId?: string;
    promptTokens?: number;
    completionTokens?: number;
    model?: string;
  }): Promise<void> {
    try {
      await this.prisma.botUsage.create({ data });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`BotUsage record failed (bot=${data.botId}, kind=${data.kind}): ${msg}`);
    }
  }
}
