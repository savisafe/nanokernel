import { Injectable, Logger } from "@nestjs/common";
import { LlmService } from "../llm/llm.service";
import type { LlmChatMessage } from "../llm/llm-provider.contract";
import type { CompactionStrings } from "../language/language-pack.types";

/** Разрешённые параметры компакции для конкретного бота. */
export interface ResolvedCompaction {
  enabled: boolean;
  /** Сколько последних сообщений оставить дословно. */
  keepRecentMessages: number;
  /** Верхняя граница на число сообщений, которые вообще тянем из БД. */
  maxFetchMessages: number;
  /** Бюджет токенов на саму выжимку. */
  maxSummaryTokens: number;
}

export interface ComposeParams {
  /** Полная хронология (asc): user/assistant с готовым content. */
  history: LlmChatMessage[];
  keepRecent: number;
  maxSummaryTokens: number;
  strings: CompactionStrings;
}

export interface ComposeResult {
  /** История для подачи в LLM (недавнее окно дословно). */
  history: LlmChatMessage[];
  /** Системная заметка с выжимкой старого (если была компакция). */
  summaryNote?: string;
}

/**
 * Суммаризационная компакция контекста: вместо слепого обрезания старых сообщений
 * (`take: N`) старая часть диалога сжимается одним LLM-вызовом в короткую сводку,
 * а недавнее окно сохраняется дословно. Для маленьких моделей с 4–8k контекста это
 * критичнее, чем для флагманов: окно кончается мгновенно, а слепая обрезка теряет
 * имена/договорённости из начала разговора.
 *
 * Fail-safe: если суммаризация не удалась — мягко падаем в обычную обрезку
 * (только недавнее окно, без сводки), а не роняем ход диалога.
 */
@Injectable()
export class ContextCompactionService {
  private readonly logger = new Logger(ContextCompactionService.name);

  constructor(private readonly llm: LlmService) {}

  async compose(params: ComposeParams): Promise<ComposeResult> {
    const { history, keepRecent, strings } = params;
    if (history.length <= keepRecent) {
      return { history };
    }
    const overflow = history.slice(0, history.length - keepRecent);
    const recent = history.slice(history.length - keepRecent);

    const transcript = overflow
      .map((m) => {
        const label = m.role === "assistant" ? strings.assistantLabel : strings.clientLabel;
        return `${label}: ${m.content ?? ""}`;
      })
      .join("\n");

    const summary = await this.llm.complete(
      [
        { role: "system", content: strings.summaryInstruction },
        { role: "user", content: transcript },
      ],
      { maxTokens: params.maxSummaryTokens, temperature: 0 },
    );

    if (!summary?.text) {
      this.logger.warn(
        `compaction: summary unavailable — fallback to plain truncation (${overflow.length} older messages dropped)`,
      );
      return { history: recent };
    }

    return { history: recent, summaryNote: `${strings.summaryNotePrefix}\n${summary.text}` };
  }
}
