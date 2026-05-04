import { Injectable, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { LlmChatMessage, LlmService } from "../llm/llm.service";
import { PrismaService } from "../prisma/prisma.service";
import { BotConfigurationService } from "../bot-configuration/bot-configuration.service";
import { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import { PromptProfileService } from "../prompt-profile/prompt-profile.service";
import { RagService } from "../rag/rag.service";
import { ResolvedLlmPromptProfile } from "../prompt-profile/prompt-profile.types";
import { DEFAULT_STRICT_KNOWLEDGE_CONVERSATIONAL_PROMPT_ADDENDUM_LINES } from "../prompt-profile/strict-knowledge-conversational.defaults";
import {
  ChannelType,
  DialogDiagnosticChunk,
  DialogInput,
  DialogOutput,
  DialogOutputWithDiagnostics,
  DialogRuntimeSnapshot,
  KnowledgeChunkRuntime,
} from "./dialog.types";

/** Шаблоны, если LLM выключен или недоступен. */
const TEMPLATE_STAGES: Record<string, { replyLines: string[] }> = {
  contact: {
    replyLines: [
      "Спасибо за сообщение!",
      "Я помогу с консультацией и подбором решения.",
      "Расскажите, пожалуйста, какая задача сейчас самая приоритетная?",
    ],
  },
  qualification: {
    replyLines: [
      "Спасибо за обращение.",
      "Правильно понял, что запрос такой: \"{clientText}\"?",
    ],
  },
};

@Injectable()
export class DialogService implements OnModuleInit {
  private defaultSnapshot!: DialogRuntimeSnapshot;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly promptProfile: PromptProfileService,
    private readonly botConfiguration: BotConfigurationService,
    private readonly ragService: RagService,
  ) {}

  onModuleInit() {
    this.defaultSnapshot = this.composeSnapshot(this.promptProfile.getProfile(), this.botConfiguration.get());
  }

  /**
   * Сборка снимка для админского теста или кастомного рантайма.
   * Прод-путь использует defaultSnapshot из env и файлов профиля/сборки на старте.
   */
  composeSnapshot(profile: ResolvedLlmPromptProfile, bot: ResolvedBotConfiguration): DialogRuntimeSnapshot {
    const { prefix, suffix } = this.buildLlmSystemPromptStaticParts(profile);
    const knowledgeChunks = this.computeKnowledgeChunksForProfile(profile);
    return {
      profile,
      bot,
      llmSystemPromptPrefix: prefix,
      llmSystemPromptSuffix: suffix,
      knowledgeChunks,
    };
  }

  /**
   * Один ход диалога с диагностикой (system prompt, retrieval).
   * Не используется вебхуками; для внутренней диагностики и тестов.
   */
  async runDiagnosticTurn(input: DialogInput, snapshot: DialogRuntimeSnapshot): Promise<DialogOutputWithDiagnostics> {
    const { conversation } = await this.getOrCreateConversation(input.channel, input.externalUserId);

    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "client",
        text: input.text,
      },
    });

    const nextStage = conversation.stage;
    const templateReply = this.buildReply(nextStage, input.text);
    const { replyText, diagnostics } = await this.tryLlmReplyWithDiagnostics(
      conversation.id,
      nextStage,
      input.channel,
      templateReply,
      input.text,
      snapshot,
    );

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        stage: nextStage,
        status: "ACTIVE",
      },
    });

    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        text: replyText,
      },
    });

    return { replyText, stage: nextStage, diagnostics };
  }

  async process(input: DialogInput): Promise<DialogOutput> {
    const snap = this.defaultSnapshot;
    const { conversation } = await this.getOrCreateConversation(
      input.channel,
      input.externalUserId,
    );

    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "client",
        text: input.text,
      },
    });

    const nextStage = conversation.stage;
    const templateReply = this.buildReply(nextStage, input.text);
    const replyText = await this.tryLlmReply(
      conversation.id,
      nextStage,
      input.channel,
      templateReply,
      input.text,
      snap,
    );
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        stage: nextStage,
        status: "ACTIVE",
      },
    });

    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        text: replyText,
      },
    });

    return { replyText, stage: nextStage };
  }

  private async getOrCreateConversation(channel: string, externalUserId: string) {
    const user = await this.getOrCreateUser(channel, externalUserId);

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        userId: user.id,
        status: "ACTIVE",
      },
      orderBy: { createdAt: "desc" },
    });

    if (conversation) {
      return { user, conversation };
    }

    const createdConversation = await this.prisma.conversation.create({
      data: { userId: user.id },
    });

    return { user, conversation: createdConversation };
  }

  private async getOrCreateUser(channel: string, externalUserId: string) {
    const existing = await this.prisma.user.findFirst({
      where: { channel, externalId: externalUserId },
    });
    if (existing) {
      return existing;
    }
    try {
      return await this.prisma.user.create({
        data: { channel, externalId: externalUserId },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const retry = await this.prisma.user.findFirst({
          where: { channel, externalId: externalUserId },
        });
        if (retry) {
          return retry;
        }
      }
      throw e;
    }
  }

  private buildReply(stage: string, clientText: string): string {
    const fallback = TEMPLATE_STAGES.contact;
    const selected = TEMPLATE_STAGES[stage] ?? fallback;
    return selected.replyLines.map((line) => line.replace("{clientText}", clientText)).join("\n");
  }

  /**
   * Приветствия и мета-вопросы не требуют фрагментов БЗ — паттерны задаются в профиле
   * (`strictKnowledgeConversationalBypass`), иначе strictKnowledgeMode даёт сухой noKnowledgeReply.
   */
  private isConversationalBypassStrictKnowledge(userText: string, profile: ResolvedLlmPromptProfile): boolean {
    const cfg = profile.strictKnowledgeConversationalBypass;
    if (!cfg || cfg.patterns.length === 0) {
      return false;
    }
    const t = userText.trim().toLowerCase();
    const maxLen = cfg.maxMessageLength;
    if (t.length === 0 || t.length > maxLen) {
      return false;
    }
    return cfg.patterns.some((re) => re.test(t));
  }

  private strictKnowledgeConversationalSystemAddendum(profile: ResolvedLlmPromptProfile): string {
    const lines = profile.strictKnowledgeConversationalPromptAddendumLines;
    const resolved =
      lines === undefined
        ? DEFAULT_STRICT_KNOWLEDGE_CONVERSATIONAL_PROMPT_ADDENDUM_LINES
        : lines;
    if (resolved.length === 0) {
      return "";
    }
    return resolved.join("\n");
  }

  private async tryLlmReply(
    conversationId: string,
    stage: string,
    channel: ChannelType,
    templateFallback: string,
    userText: string,
    snap: DialogRuntimeSnapshot,
  ): Promise<string> {
    const r = await this.tryLlmReplyCore(conversationId, stage, channel, templateFallback, userText, snap);
    return r.replyText;
  }

  private async tryLlmReplyWithDiagnostics(
    conversationId: string,
    stage: string,
    channel: ChannelType,
    templateFallback: string,
    userText: string,
    snap: DialogRuntimeSnapshot,
  ): Promise<{ replyText: string; diagnostics: DialogOutputWithDiagnostics["diagnostics"] }> {
    return this.tryLlmReplyCore(conversationId, stage, channel, templateFallback, userText, snap);
  }

  private async tryLlmReplyCore(
    conversationId: string,
    stage: string,
    channel: ChannelType,
    templateFallback: string,
    userText: string,
    snap: DialogRuntimeSnapshot,
  ): Promise<{
    replyText: string;
    diagnostics: DialogOutputWithDiagnostics["diagnostics"];
  }> {
    if (!this.llmService.isEnabled()) {
      return {
        replyText: templateFallback,
        diagnostics: await this.buildDiagnosticsForDisabledLlm(snap, stage, channel),
      };
    }

    const contextLimit = this.getLlmContextMessageLimit();
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: contextLimit,
    });
    rows.reverse();

    const profile = snap.profile;
    const conversationalBypass =
      Boolean(profile.strictKnowledgeMode && profile.scopeText) &&
      this.isConversationalBypassStrictKnowledge(userText, profile);
    const retrieval = conversationalBypass
      ? { context: undefined as string | undefined, mode: "none" as const, chunks: [] as DialogDiagnosticChunk[] }
      : await this.retrieveKnowledgeContextDetailed(userText, snap);

    const knowledgeContext = retrieval.context;

    if (profile.strictKnowledgeMode && profile.scopeText && !knowledgeContext && !conversationalBypass) {
      const replyText =
        profile.noKnowledgeReply ??
        "По этому запросу в подключённой базе не нашлось подходящего фрагмента. Переформулируйте вопрос или уточните тему — я подберу ответ из документа.";
      const system =
        this.buildSystemPrompt(stage, channel, undefined, snap) +
        (conversationalBypass ? this.strictKnowledgeConversationalSystemAddendum(profile) : "");
      return {
        replyText,
        diagnostics: {
          systemPrompt: system,
          knowledgeContext,
          chunks: retrieval.chunks,
          retrievalMode: retrieval.mode,
        },
      };
    }

    const system =
      this.buildSystemPrompt(stage, channel, knowledgeContext, snap) +
      (conversationalBypass ? this.strictKnowledgeConversationalSystemAddendum(profile) : "");
    const messages: LlmChatMessage[] = [
      { role: "system", content: system },
      ...rows.map((m) => ({
        role: (m.role === "client" ? "user" : "assistant") as "user" | "assistant",
        content: m.text,
      })),
    ];

    const out = await this.llmService.complete(messages);
    const replyText = out ?? templateFallback;
    return {
      replyText,
      diagnostics: {
        systemPrompt: system,
        knowledgeContext,
        chunks: retrieval.chunks,
        retrievalMode: retrieval.mode,
      },
    };
  }

  private emptyDiagnostics(snap: DialogRuntimeSnapshot): DialogOutputWithDiagnostics["diagnostics"] {
    const system = this.buildSystemPrompt("contact", "telegram", undefined, snap);
    return { systemPrompt: system, chunks: [], retrievalMode: "none" };
  }

  private async buildDiagnosticsForDisabledLlm(
    snap: DialogRuntimeSnapshot,
    stage: string,
    channel: ChannelType,
  ): Promise<DialogOutputWithDiagnostics["diagnostics"]> {
    const system = this.buildSystemPrompt(stage, channel, undefined, snap);
    return { systemPrompt: system, chunks: [], retrievalMode: "none" };
  }

  private computeKnowledgeChunksForProfile(p: ResolvedLlmPromptProfile): KnowledgeChunkRuntime[] {
    if (!p.scopeText || p.scopeText.trim().length === 0) {
      return [];
    }
    const chunkSize = p.retrievalChunkSize ?? 1400;
    const overlap = Math.min(p.retrievalChunkOverlap ?? 200, Math.max(0, chunkSize - 50));
    return this.buildKnowledgeChunks(p.scopeText, chunkSize, overlap);
  }

  private buildSystemPrompt(
    stage: string,
    channel: ChannelType,
    knowledgeContext: string | undefined,
    snap: DialogRuntimeSnapshot,
  ): string {
    const open = snap.profile.openTopicsMode;
    const stageLine = open
      ? "Режим: свободный диалог (без воронки продаж)."
      : `Текущий этап воронки: ${stage}.`;
    const knowledgeBlock = knowledgeContext
      ? `\n\nРелевантные фрагменты базы знаний для текущего запроса:\n${knowledgeContext}`
      : "";
    return `${snap.llmSystemPromptPrefix}Канал: ${channel}. ${stageLine}\n${snap.llmSystemPromptSuffix}${knowledgeBlock}`;
  }

  private buildLlmSystemPromptStaticParts(p: ResolvedLlmPromptProfile): { prefix: string; suffix: string } {
    const company = p.companyName;
    const topic = p.topic;
    const forbidden = p.forbiddenTopics;
    const scopeFromFile = p.scopeText;
    const neverDo = p.neverDo ?? [];
    const primaryGoals = p.primaryGoals ?? [];
    const lang = p.language ?? "русский";

    const prefixLines: string[] = [];
    if (p.persona) {
      prefixLines.push(p.persona);
    } else {
      //TODO hardcode
      prefixLines.push(`Ты — AI-менеджер компании ${company}.`);
    }
    const prefix = `${prefixLines.join("\n")}\n`;

    const lines: string[] = [];
    lines.push(`Основной язык ответов: ${lang}.`, "");

    if (primaryGoals.length > 0) {
      lines.push("Цели в этом чате:", ...primaryGoals.map((g) => `- ${g}`), "");
    } else if (p.openTopicsMode) {
      lines.push(
        "Твоя цель: вести полезный и уважительный диалог по теме собеседника, без навязывания продукта.",
        "",
      );
    } else {
      lines.push("Твоя цель: помогать клиентам в чате, консультировать и продавать по скриптам без давления.", "");
    }

    if (p.servicesHighlight) {
      lines.push("Фокус услуг и предложений:", p.servicesHighlight, "");
    }

    if (topic) {
      lines.push(
        "Рамка темы (только она, без общих отступлений):",
        topic,
        "",
        "Вне темы: за 1–2 фразы вежливо откажи, верни к продукту или предложи менеджера; не советуй по медицине, юриспруденции, инвестициям и т.п. вне рамки продукта.",
      );
    }

    if (forbidden.length > 0) {
      lines.push(
        "",
        "Не обсуждай и не развивай эти темы (даже по просьбе клиента):",
        ...forbidden.map((f) => `- ${f}`),
      );
    }

    if (neverDo.length > 0) {
      lines.push("", "Категорически:", ...neverDo.map((f) => `- ${f}`));
    }

    if (scopeFromFile) {
      lines.push(
        "",
        "База знаний подключена. Используй только факты из релевантных фрагментов ниже по запросу пользователя.",
      );
      if (p.strictKnowledgeMode) {
        lines.push(
          "- Если релевантные фрагменты не переданы или в них нет ответа по сути вопроса: скажи это коротко и по-человечески, предложи переформулировать или уточнить тему.",
          "- Не выдумывай нормы, пункты, подпункты, таблицы и числовые значения.",
        );
      }
    }

    if (p.bookingAndContact) {
      lines.push("", "Запись и контакты (не выдумывай данные):", p.bookingAndContact);
    }

    if (p.humanLikeMode) {
      lines.push(
        "",
        "Режим «как живой человек» (тема и факты не ослабляй):",
        "- Меняй формулировки, избегай шаблонных вступлений подряд; допустим разговорный тон, без канцелярита и «отчётных» списков ради списка.",
        "- Не превращай каждый ответ в FAQ: 1–2 живых абзаца; покажи, что услышал запрос, без воды и лишних извинений.",
        "- Смайлики по минимуму (один нейтральный или без них); без «рад видеть» в каждом сообщении.",
      );
    }

    const styleLead = p.humanLikeMode
      ? "- Пиши коротко и по-человечески: дружелюбно, без сухого отчёта."
      : "- Пиши коротко, дружелюбно.";

    if (p.openTopicsMode) {
      lines.push(
        "",
        "Правила стиля:",
        styleLead,
        "- Развивай беседу по запросу пользователя; не уводи насильно к продаже или к одной нише.",
        "- Не выдавай за факт то, чего не знаешь; при сложных вопросах (медицина, право, финансы) — общая информация и рекомендация обратиться к специалисту, без диагнозов и юридических заключений.",
        p.humanLikeMode
          ? "- В конце можно один уточняющий вопрос или предложение продолжить тему — по ситуации."
          : "- Один ответ = несколько коротких абзацев по делу.",
      );
    } else {
      lines.push(
        "",
        "Правила стиля и продаж:",
        styleLead,
        "- Сначала уточняй потребность, потом предлагай решение.",
        "- Не выдумывай цены, сроки и условия; если данных нет — скажи, что уточнит менеджер.",
        p.humanLikeMode
          ? "- В конце — один ясный следующий шаг или вопрос; не обязательно «официальное» закрытие абзаца."
          : "- Один ответ = несколько коротких абзацев, в конце один конкретный следующий шаг.",
      );
    }

    if (p.additionalStyleRules?.length) {
      for (const rule of p.additionalStyleRules) {
        lines.push(`- ${rule}`);
      }
    }

    return { prefix, suffix: lines.join("\n") };
  }

  /** Сколько последних сообщений диалога отдавать в LLM (меньше — быстрее префилл и инференс). */
  private getLlmContextMessageLimit(): number {
    const raw = process.env.LLM_CONTEXT_MESSAGES?.trim();
    if (raw === undefined || raw === "") {
      return 16;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return 16;
    }
    return Math.min(50, Math.max(2, Math.floor(n)));
  }

  private buildKnowledgeChunks(scopeText: string, chunkSize: number, overlap: number): KnowledgeChunkRuntime[] {
    const normalized = scopeText.replace(/\r\n/g, "\n").trim();
    if (!normalized) {
      return [];
    }

    const chunks: KnowledgeChunkRuntime[] = [];
    let start = 0;
    let id = 1;
    while (start < normalized.length) {
      const end = Math.min(normalized.length, start + chunkSize);
      const cut = this.findChunkBoundary(normalized, start, end);
      const text = normalized.slice(start, cut).trim();
      if (text.length > 0) {
        chunks.push({ id, text, tokens: new Set(this.tokenizeForRetrieval(text)) });
        id += 1;
      }
      if (cut >= normalized.length) {
        break;
      }
      start = Math.max(cut - overlap, start + 1);
    }
    return chunks;
  }

  private findChunkBoundary(text: string, start: number, targetEnd: number): number {
    if (targetEnd >= text.length) {
      return text.length;
    }
    const breakpoints = ["\n\n", "\n", ". ", "; ", ", "];
    for (const point of breakpoints) {
      const idx = text.lastIndexOf(point, targetEnd);
      if (idx > start + 200) {
        return idx + point.length;
      }
    }
    return targetEnd;
  }

  private async retrieveKnowledgeContextDetailed(
    userText: string,
    snap: DialogRuntimeSnapshot,
  ): Promise<{ context?: string; mode: "none" | "lexical" | "rag"; chunks: DialogDiagnosticChunk[] }> {
    if (snap.bot.useRag && this.ragService.isInitialized()) {
      const topK = snap.profile.retrievalTopK ?? 3;
      const results = await this.ragService.search(userText, topK);
      if (results.length === 0) {
        return { mode: "rag", chunks: [] };
      }
      return {
        mode: "rag",
        context: results
          .map((r) => `[Релевантность: ${(r.score * 100).toFixed(1)}%]\n${r.text}`)
          .join("\n\n---\n\n"),
        chunks: results.map((r) => ({ text: r.text, score: r.score })),
      };
    }

    if (snap.knowledgeChunks.length === 0) {
      return { mode: "none", chunks: [] };
    }
    const queryTokens = this.tokenizeForRetrieval(userText);
    if (queryTokens.length === 0) {
      return { mode: "lexical", chunks: [] };
    }
    const querySet = new Set(queryTokens);
    const scored = snap.knowledgeChunks
      .map((chunk) => {
        let overlap = 0;
        for (const token of querySet) {
          if (chunk.tokens.has(token)) {
            overlap += 1;
          }
        }
        return { chunk, overlap };
      })
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || a.chunk.id - b.chunk.id);

    if (scored.length === 0) {
      return { mode: "lexical", chunks: [] };
    }

    const topK = snap.profile.retrievalTopK ?? 3;
    const top = scored.slice(0, topK);
    return {
      mode: "lexical",
      context: top
        .map((x) => `[Фрагмент ${x.chunk.id}, совпадений: ${x.overlap}]\n${x.chunk.text}`)
        .join("\n\n---\n\n"),
      chunks: top.map((x) => ({ id: x.chunk.id, text: x.chunk.text, overlap: x.overlap })),
    };
  }

  private tokenizeForRetrieval(text: string): string[] {
    const raw = text
      .toLowerCase()
      .replace(/ё/g, "е")
      .split(/[^a-zа-я0-9.]+/i)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    const stopWords = new Set([
      "и",
      "в",
      "на",
      "по",
      "с",
      "для",
      "к",
      "о",
      "об",
      "от",
      "до",
      "или",
      "что",
      "как",
      "какой",
      "какие",
      "это",
      "пункт",
      "подпункт",
    ]);
    return raw.filter((t) => !stopWords.has(t));
  }
}
