import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma, User } from "@prisma/client";
import { LlmChatMessage, LlmService } from "../llm/llm.service";
import { PrismaService } from "../prisma/prisma.service";
import { BotConfigurationService } from "../bot-configuration/bot-configuration.service";
import { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import { PromptProfileService } from "../prompt-profile/prompt-profile.service";
import { RagService } from "../rag/rag.service";
import { ResolvedLlmPromptProfile } from "../prompt-profile/prompt-profile.types";
import { DEFAULT_STRICT_KNOWLEDGE_CONVERSATIONAL_PROMPT_ADDENDUM_LINES } from "../prompt-profile/strict-knowledge-conversational.defaults";
import { SnippetMatcherService } from "../snippets/snippet-matcher.service";
import { isDevelopment } from "../shared/is-development";
import type { DialogRetrievalPresentation, EffectiveDialogRuntime } from "./dialog.config.types";
import { resolveEffectiveDialog } from "./dialog-effective";
import { interpolateTemplate } from "./dialog-template.utils";
import {
  ChannelType,
  DialogDiagnosticChunk,
  DialogInput,
  DialogOutput,
  DialogOutputWithDiagnostics,
  DialogRuntimeSnapshot,
  KnowledgeChunkRuntime,
} from "./dialog.types";

@Injectable()
export class DialogService {
  private readonly logger = new Logger(DialogService.name);

  private static readonly GLOBAL_KNOWLEDGE_REQUEST_PATTERNS: readonly RegExp[] = [
      //TODO ru hardcode, move
    /(?:^|[\s,.;:!?«»(])(пересказ|перескажи|суммарно|суммируй|кратко|резюме|выжимк|расскажи|опиши|объясни)(?:[\s,.;:!?»)]|$)/iu,
      //TODO move magic link
    /(^|\s)(summary|summarize|overview|tl;dr)(\s|$|[,.!?])/i,
    /(?:^|[\s,.;:!?«»(])(о\s+ч[её]м\s+документ|что\s+за\s+документ)(?:[\s,.;:!?»)]|$)/iu,
  ];
  private readonly effective: EffectiveDialogRuntime;
  private readonly knowledgeChunksCache = new Map<string, KnowledgeChunkRuntime[]>();
  private readonly tokenizationRuntimeCache = new Map<
    string,
    { regex: RegExp; stopWords: Set<string> }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly promptProfile: PromptProfileService,
    private readonly botConfiguration: BotConfigurationService,
    private readonly ragService: RagService,
    private readonly snippetMatcher: SnippetMatcherService,
  ) {
    this.effective = resolveEffectiveDialog(this.botConfiguration.get());
  }

  getTelegramKnowledgeOnboarding() {
    return this.effective.telegramKnowledgeOnboarding;
  }

  async getTelegramKnowledgeOnboardingForExternalUser(externalUserId: string) {
    const user = await this.prisma.user.findFirst({
      where: { channel: "telegram", externalId: externalUserId },
    });
    const selected = user?.selectedBotConfigurationId?.trim();
    const bot = selected ? this.botConfiguration.resolveById(selected) : this.botConfiguration.get();
    return this.effectiveFor(bot).telegramKnowledgeOnboarding;
  }

  isGlobalKnowledgeIntent(text: string): boolean {
    return this.isGlobalKnowledgeRequest(text);
  }

  composeSnapshot(profile: ResolvedLlmPromptProfile, bot: ResolvedBotConfiguration): DialogRuntimeSnapshot {
    const { prefix, suffix } = this.buildLlmSystemPromptStaticParts(profile, bot);
    const knowledgeChunks = this.computeKnowledgeChunksForProfile(profile, bot);
    return {
      profile,
      bot,
      llmSystemPromptPrefix: prefix,
      llmSystemPromptSuffix: suffix,
      knowledgeChunks,
    };
  }

  private resolveRuntimeSnapshotForUser(channel: ChannelType, user: User): DialogRuntimeSnapshot {
    const globalBot = this.botConfiguration.get();
    const bot =
      user.selectedBotConfigurationId?.trim().length
        ? this.botConfiguration.resolveById(user.selectedBotConfigurationId.trim())
        : globalBot;
    const profile = this.promptProfile.resolveProfileForBot(bot);
    const base = this.composeSnapshot(profile, bot);
    const scope = user.knowledgeScopeText?.trim();
    if (channel === "telegram" && scope && scope.length > 0) {
      const profileScoped: ResolvedLlmPromptProfile = {
        ...base.profile,
        scopeText: scope,
      };
      const { prefix, suffix } = this.buildLlmSystemPromptStaticParts(profileScoped, base.bot);
      return {
        profile: profileScoped,
        bot: base.bot,
        llmSystemPromptPrefix: prefix,
        llmSystemPromptSuffix: suffix,
        knowledgeChunks: this.getCachedKnowledgeChunksForScope(scope, profileScoped, base.bot),
        disableRag: true,
      };
    }
    return base;
  }

  /**
   * Один ход диалога с диагностикой (system prompt, retrieval).
   * Не используется вебхуками; для внутренней диагностики и тестов.
   */
  //TODO legacy, unuse, need add linter
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
    const templateReply = this.buildReply(nextStage, input.text, snapshot);
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
    const { conversation, user } = await this.getOrCreateConversation(
      input.channel,
      input.externalUserId,
    );
    const snap = this.resolveRuntimeSnapshotForUser(input.channel, user);

    if (
      input.channel === "telegram" &&
      snap.profile.strictKnowledgeMode &&
      !user.knowledgeScopeText?.trim()
    ) {
      const onboarding = this.effectiveFor(snap.bot).telegramKnowledgeOnboarding;
      const replyText = user.telegramKnowledgeAwaiting
        ? onboarding.strictNoScopeAwaitingDraft
        : onboarding.strictNoScopeNeedNew;
      await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "client",
          text: input.text,
        },
      });
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { stage: conversation.stage, status: "ACTIVE" },
      });
      await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          text: replyText,
        },
      });
      return { replyText, stage: conversation.stage };
    }

    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "client",
        text: input.text,
      },
    });

    const snippetHit = this.snippetMatcher.match(input.text, snap.bot);
    if (snippetHit) {
      if (isDevelopment()) {
        this.logger.debug(`snippet hit bot=${snap.bot.id} id=${snippetHit.id} (no LLM call)`);
      }
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { stage: conversation.stage, status: "ACTIVE" },
      });
      await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          text: snippetHit.reply,
        },
      });
      return { replyText: snippetHit.reply, stage: conversation.stage };
    }

    const nextStage = conversation.stage;
    const templateReply = this.buildReply(nextStage, input.text, snap);
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

  private effectiveFor(bot: ResolvedBotConfiguration): EffectiveDialogRuntime {
    if (bot.id === this.botConfiguration.get().id) {
      return this.effective;
    }
    return resolveEffectiveDialog(bot);
  }

  private tokenizationRuntime(bot: ResolvedBotConfiguration): { regex: RegExp; stopWords: Set<string> } {
    let cached = this.tokenizationRuntimeCache.get(bot.id);
    if (!cached) {
      const eff = this.effectiveFor(bot);
      cached = {
        regex: new RegExp(eff.tokenization.splitPattern, eff.tokenization.splitFlags),
        stopWords: new Set(eff.tokenization.stopWords),
      };
      this.tokenizationRuntimeCache.set(bot.id, cached);
    }
    return cached;
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

  private buildReply(stage: string, clientText: string, snap: DialogRuntimeSnapshot): string {
    const { templateStages } = this.effectiveFor(snap.bot);
    const selected = templateStages[stage] ?? templateStages.contact;
    if (!selected) {
      return clientText;
    }
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
    const dialogCfg = this.effectiveFor(snap.bot);
    if (!this.llmService.isEnabled()) {
      return {
        replyText: templateFallback,
        diagnostics: await this.buildDiagnosticsForDisabledLlm(snap, stage, channel),
      };
    }

    const contextLimit = this.getLlmContextMessageLimit(snap.bot);
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
      const replyText = profile.noKnowledgeReply ?? dialogCfg.fallbackNoKnowledgeReply;
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

    const out = await this.llmService.complete(messages, snap.bot.llm);
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

  private async buildDiagnosticsForDisabledLlm(
    snap: DialogRuntimeSnapshot,
    stage: string,
    channel: ChannelType,
  ): Promise<DialogOutputWithDiagnostics["diagnostics"]> {
    const system = this.buildSystemPrompt(stage, channel, undefined, snap);
    return { systemPrompt: system, chunks: [], retrievalMode: "none" };
  }

  private computeKnowledgeChunksForProfile(
    p: ResolvedLlmPromptProfile,
    bot: ResolvedBotConfiguration,
  ): KnowledgeChunkRuntime[] {
    if (!p.scopeText || p.scopeText.trim().length === 0) {
      return [];
    }
    return this.getCachedKnowledgeChunksForScope(p.scopeText, p, bot);
  }

  private getCachedKnowledgeChunksForScope(
    scopeText: string,
    p: ResolvedLlmPromptProfile,
    bot: ResolvedBotConfiguration,
  ): KnowledgeChunkRuntime[] {
    const scope = scopeText.trim();
    if (!scope) {
      return [];
    }
    const defaults = this.effectiveFor(bot).chunkDefaults;
    const chunkSize = p.retrievalChunkSize ?? defaults.chunkSize;
    const overlap = Math.min(
      p.retrievalChunkOverlap ?? defaults.overlap,
      Math.max(0, chunkSize - defaults.overlapClampSubtract),
    );
    const scopeHash = createHash("sha256").update(scope).digest("hex");
    const cacheKey = `${bot.id}:${chunkSize}:${overlap}:${scopeHash}`;
    const cached = this.knowledgeChunksCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const built = this.buildKnowledgeChunks(scope, chunkSize, overlap, bot);
    this.knowledgeChunksCache.set(cacheKey, built);
    const maxCacheEntries = 100;
    if (this.knowledgeChunksCache.size > maxCacheEntries) {
      const firstKey = this.knowledgeChunksCache.keys().next().value;
      if (firstKey) {
        this.knowledgeChunksCache.delete(firstKey);
      }
    }
    return built;
  }

  private buildSystemPrompt(
    stage: string,
    channel: ChannelType,
    knowledgeContext: string | undefined,
    snap: DialogRuntimeSnapshot,
  ): string {
    const eff = this.effectiveFor(snap.bot);
    const knowledgeBlockRaw = knowledgeContext ?? "";

    if (eff.systemKind === "template") {
      const stageLine = snap.profile.openTopicsMode
        ? eff.stageFrame.openTopicsStageLine
        : interpolateTemplate(eff.stageFrame.funnelStageLineTemplate, { stage });
      return interpolateTemplate(eff.systemPromptTemplate, {
        knowledgeBlock: knowledgeBlockRaw,
        channel,
        stage,
        stageLine,
        prefix: snap.llmSystemPromptPrefix,
        suffix: snap.llmSystemPromptSuffix,
      });
    }

    const frame = eff.systemPromptFrame;
    const open = snap.profile.openTopicsMode;
    const stageLine = open
      ? frame.openTopicsStageLine
      : interpolateTemplate(frame.funnelStageLineTemplate, { stage });
    const knowledgeBlock = knowledgeContext ? `${frame.knowledgeBlockIntro}${knowledgeContext}` : "";
    return interpolateTemplate(frame.assembledTemplate, {
      prefix: snap.llmSystemPromptPrefix,
      channel,
      stageLine,
      suffix: snap.llmSystemPromptSuffix,
      knowledgeBlock,
    });
  }

  private buildLlmSystemPromptStaticParts(
    p: ResolvedLlmPromptProfile,
    bot: ResolvedBotConfiguration,
  ): { prefix: string; suffix: string } {
    const eff = this.effectiveFor(bot);
    if (eff.systemKind === "template") {
      return { prefix: "", suffix: "" };
    }
    const suf = eff.staticPromptSuffix;
    const company = p.companyName;
    const topic = p.topic;
    const forbidden = p.forbiddenTopics;
    const scopeFromFile = p.scopeText;
    const neverDo = p.neverDo ?? [];
    const primaryGoals = p.primaryGoals ?? [];
    const lang = p.language ?? suf.defaultLanguage;

    const prefixLines: string[] = [];
    if (p.persona) {
      prefixLines.push(p.persona);
    } else {
      prefixLines.push(interpolateTemplate(suf.defaultPersonaTemplate, { company }));
    }
    const prefix = `${prefixLines.join("\n")}\n`;

    const lines: string[] = [];
    lines.push(interpolateTemplate(suf.mainLanguageLineTemplate, { lang }), "");

    if (primaryGoals.length > 0) {
      lines.push(
        suf.primaryGoalsHeader,
        ...primaryGoals.map((g) => `${suf.goalItemPrefix}${g}`),
        "",
      );
    } else if (p.openTopicsMode) {
      lines.push(suf.openTopicsPrimaryGoal, "");
    } else {
      lines.push(suf.funnelPrimaryGoal, "");
    }

    if (p.servicesHighlight) {
      lines.push(suf.servicesHighlightHeader, p.servicesHighlight, "");
    }

    if (topic) {
      lines.push(suf.topicHeader, topic, "", suf.topicOutOfScopeGuidance);
    }

    if (forbidden.length > 0) {
      lines.push(
        "",
        suf.forbiddenSectionHeader,
        ...forbidden.map((f) => `${suf.forbiddenItemPrefix}${f}`),
      );
    }

    if (neverDo.length > 0) {
      lines.push("", suf.neverDoSectionHeader, ...neverDo.map((f) => `${suf.neverDoItemPrefix}${f}`));
    }

    if (scopeFromFile) {
      lines.push("", suf.scopeConnectedIntro);
      if (p.strictKnowledgeMode) {
        lines.push(...suf.strictKnowledgeBullets.map((b) => `- ${b}`));
      }
    }

    if (p.bookingAndContact) {
      lines.push("", suf.bookingSectionHeader, p.bookingAndContact);
    }

    if (p.humanLikeMode) {
      lines.push(
        "",
        suf.humanLikeSectionHeader,
        ...suf.humanLikeBullets.map((b) => `- ${b}`),
      );
    }

    const styleLead = p.humanLikeMode ? suf.styleLeadHumanLike : suf.styleLeadDefault;

    if (p.openTopicsMode) {
      const ots = suf.openTopicsStyle;
      lines.push(
        "",
        ots.sectionTitle,
        styleLead,
        ...ots.sharedBullets.map((b) => `- ${b}`),
        `- ${p.humanLikeMode ? ots.lastBulletHumanLike : ots.lastBulletDefault}`,
      );
    } else {
      const fs = suf.funnelStyle;
      lines.push(
        "",
        fs.sectionTitle,
        styleLead,
        ...fs.sharedBullets.map((b) => `- ${b}`),
        `- ${p.humanLikeMode ? fs.lastBulletHumanLike : fs.lastBulletDefault}`,
      );
    }

    if (p.additionalStyleRules?.length) {
      for (const rule of p.additionalStyleRules) {
        lines.push(`${suf.additionalStyleRulePrefix}${rule}`);
      }
    }

    return { prefix, suffix: lines.join("\n") };
  }

  /** Сколько последних сообщений диалога отдавать в LLM (меньше — быстрее префилл и инференс). */
  private getLlmContextMessageLimit(bot: ResolvedBotConfiguration): number {
    const cfg = this.effectiveFor(bot).llmContextMessages;
    const raw = process.env[cfg.envVarName]?.trim();
    if (raw === undefined || raw === "") {
      return cfg.defaultLimit;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return cfg.defaultLimit;
    }
    return Math.min(cfg.max, Math.max(cfg.min, Math.floor(n)));
  }

  private buildKnowledgeChunks(
    scopeText: string,
    chunkSize: number,
    overlap: number,
    bot: ResolvedBotConfiguration,
  ): KnowledgeChunkRuntime[] {
    const normalized = scopeText.replace(/\r\n/g, "\n").trim();
    if (!normalized) {
      return [];
    }

    const chunks: KnowledgeChunkRuntime[] = [];
    let start = 0;
    let id = 1;
    while (start < normalized.length) {
      const end = Math.min(normalized.length, start + chunkSize);
      const cut = this.findChunkBoundary(normalized, start, end, bot);
      const text = normalized.slice(start, cut).trim();
      if (text.length > 0) {
        chunks.push({ id, text, tokens: new Set(this.tokenizeForRetrieval(text, bot)) });
        id += 1;
      }
      if (cut >= normalized.length) {
        break;
      }
      start = Math.max(cut - overlap, start + 1);
    }
    return chunks;
  }

  private findChunkBoundary(
    text: string,
    start: number,
    targetEnd: number,
    bot: ResolvedBotConfiguration,
  ): number {
    const { breakpoints, minAdvanceChars } = this.effectiveFor(bot).chunkBoundaries;
    if (targetEnd >= text.length) {
      return text.length;
    }
    for (const point of breakpoints) {
      const idx = text.lastIndexOf(point, targetEnd);
      if (idx > start + minAdvanceChars) {
        return idx + point.length;
      }
    }
    return targetEnd;
  }

  private async retrieveKnowledgeContextDetailed(
    userText: string,
    snap: DialogRuntimeSnapshot,
  ): Promise<{ context?: string; mode: "none" | "lexical" | "rag"; chunks: DialogDiagnosticChunk[] }> {
    const rp = this.effectiveFor(snap.bot).retrievalPresentation;
    const defaultTopK = rp.defaultTopK;
    const maxContextChars = rp.maxContextChars ?? 5000;
    const maxChunkChars = rp.maxChunkChars ?? 1400;

    const allowRag = snap.bot.useRag && this.ragService.isInitialized() && !snap.disableRag;
    if (allowRag) {
      const topK = snap.profile.retrievalTopK ?? defaultTopK;
      const results = await this.ragService.search(userText, topK);
      if (results.length > 0) {
        const formatted = this.formatRetrievedContext(
          results.map((r) =>
            interpolateTemplate(rp.ragScoreLineTemplate, {
              scorePercent: (r.score * 100).toFixed(1),
              text: this.trimRetrievedChunkText(r.text, maxChunkChars),
            }),
          ),
          rp.chunkJoinSeparator,
          maxContextChars,
        );
        return {
          mode: "rag",
          context: formatted,
          chunks: results.map((r) => ({ text: r.text, score: r.score })),
        };
      }
      if (snap.knowledgeChunks.length === 0) {
        return { mode: "rag", chunks: [] };
      }
    }

    if (snap.knowledgeChunks.length === 0) {
      return { mode: "none", chunks: [] };
    }
    const queryTokens = this.tokenizeForRetrieval(userText, snap.bot);
    if (queryTokens.length === 0) {
      if (this.isGlobalKnowledgeRequest(userText)) {
        return this.lexicalIntroChunksFromStartOfBase(snap, rp, maxContextChars, maxChunkChars);
      }
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
      if (this.isGlobalKnowledgeRequest(userText)) {
        return this.lexicalIntroChunksFromStartOfBase(snap, rp, maxContextChars, maxChunkChars);
      }
      return { mode: "lexical", chunks: [] };
    }

    const topK = snap.profile.retrievalTopK ?? defaultTopK;
    const top = scored.slice(0, topK);
    const formatted = this.formatRetrievedContext(
      top.map((x) =>
        interpolateTemplate(rp.lexicalFragmentLineTemplate, {
          id: x.chunk.id,
          overlap: x.overlap,
          text: this.trimRetrievedChunkText(x.chunk.text, maxChunkChars),
        }),
      ),
      rp.chunkJoinSeparator,
      maxContextChars,
    );
    return {
      mode: "lexical",
      context: formatted,
      chunks: top.map((x) => ({ id: x.chunk.id, text: x.chunk.text, overlap: x.overlap })),
    };
  }

  private lexicalIntroChunksFromStartOfBase(
    snap: DialogRuntimeSnapshot,
    rp: DialogRetrievalPresentation,
    maxContextChars: number,
    maxChunkChars: number,
  ): { context?: string; mode: "lexical"; chunks: DialogDiagnosticChunk[] } {
    const topK = snap.profile.retrievalTopK ?? rp.defaultTopK;
    const top = snap.knowledgeChunks.slice(0, topK);
    if (top.length === 0) {
      return { mode: "lexical", chunks: [] };
    }
    const formatted = this.formatRetrievedContext(
      top.map((x) =>
        interpolateTemplate(rp.lexicalFragmentLineTemplate, {
          id: x.id,
          overlap: 0,
          text: this.trimRetrievedChunkText(x.text, maxChunkChars),
        }),
      ),
      rp.chunkJoinSeparator,
      maxContextChars,
    );
    return {
      mode: "lexical",
      context: formatted,
      chunks: top.map((x) => ({ id: x.id, text: x.text, overlap: 0 })),
    };
  }

  private trimRetrievedChunkText(text: string, maxChunkChars: number): string {
    const normalized = text.trim();
    if (normalized.length <= maxChunkChars) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxChunkChars - 1)).trimEnd()}…`;
  }

  private formatRetrievedContext(
    fragments: string[],
    separator: string,
    maxContextChars: number,
  ): string | undefined {
    if (fragments.length === 0) {
      return undefined;
    }
    const parts: string[] = [];
    let size = 0;
    for (const fragment of fragments) {
      const piece = fragment.trim();
      if (!piece) {
        continue;
      }
      const extra = (parts.length > 0 ? separator.length : 0) + piece.length;
      if (size + extra > maxContextChars) {
        break;
      }
      parts.push(piece);
      size += extra;
    }
    if (parts.length === 0) {
      return undefined;
    }
    return parts.join(separator);
  }

  private isGlobalKnowledgeRequest(userText: string): boolean {
    const text = userText.trim().toLowerCase().replace(/ё/g, "е");
    if (!text) {
      return false;
    }
    if (DialogService.GLOBAL_KNOWLEDGE_REQUEST_PATTERNS.some((pattern) => pattern.test(text))) {
      return true;
    }

    if (
        //TODO ru hardcode
      /(?:^|[\s,.;:!?«»(])(о\s+чем|о\s+чём|про\s+что|про\s+чём|на\s+чём|на\s+чем|что\s+за)\s+/iu.test(
        text,
      )
    ) {
      return true;
    }

    const hasDocAnchor =
        //TODO ru hardcode
        /(?:^|[\s,.;:!?«»(])(документ|документа|документе|текст|текста|файл|файла|база|базу|материал|материалу|загружен|загрузил)(?:[\s,.;:!?»)]|$)/iu.test(
        text,
      );
    const hasGlobalIntentVerb =
      /(?:^|[\s,.;:!?«»(])(расскажи|опиши|объясни|суммируй|кратко|краткий|перескажи|summary|overview|tl;dr|что\s+за|о\s+чем|о\s+чём)(?:[\s,.;:!?»)]|$)/iu.test(
        text,
      );
    if (hasDocAnchor && hasGlobalIntentVerb) {
      return true;
    }

    const maxLen = 140;
    if (text.length <= maxLen) {
      if (/^(как\s+дела|как\s+жизнь|как\s+поживаешь|что\s+нового)\s*[?.!]?$/iu.test(text)) {
        return false;
      }
      const interrogativeLead =
        /^(что|кто|где|когда|почему|зачем|сколько|какой|какая|какое|какие|чей|чья|чьё|чьи|как)\s+/iu.test(
          text,
        );
      if (interrogativeLead) {
        return true;
      }
    }

    return false;
  }

  private tokenizeForRetrieval(text: string, bot: ResolvedBotConfiguration): string[] {
    const eff = this.effectiveFor(bot);
    const minLen = eff.tokenization.minTokenLength;
    const { regex, stopWords } = this.tokenizationRuntime(bot);
    const raw = text
      .toLowerCase()
      .replace(/ё/g, "е")
      .split(regex)
      .map((t) => t.trim())
      .filter((t) => t.length >= minLen);
    return raw.filter((t) => !stopWords.has(t));
  }
}
