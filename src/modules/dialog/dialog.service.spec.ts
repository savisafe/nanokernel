import { describe, it, expect, vi, beforeEach } from "vitest";
import { DialogService } from "./dialog.service";
import { SafetyOutService } from "../safety/safety-out.service";
import type { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import type { ResolvedLlmPromptProfile } from "../prompt-profile/prompt-profile.types";
import type { ScriptStepOutcome } from "../scripts/script.types";
import type { SafetyInResult } from "../safety/safety.types";
import type { SnippetHit } from "../snippets/snippet.types";
import type { LlmCompleteResult } from "../llm/llm.service";

/**
 * Golden-тесты каскада DialogService.process(). Сервис инстанцируется напрямую с
 * фейками (без Nest DI). Каждый кейс фиксирует одну ветку каскада:
 * rate-limit → burst → repeat → content-safety → FSM → snippet → LLM → safety-out,
 * а также инварианты («битый» ответ не пишется в историю, snippet не зовёт LLM).
 */

const BOT: ResolvedBotConfiguration = {
  id: "test-bot",
  llmPromptProfile: "test-bot",
  useRag: false,
  dialog: { systemPrompt: { template: "SYS channel={channel} stage={stage} {knowledgeBlock}" } },
  guardrails: { llmFallbackReply: "Технический сбой, напишите через минуту." },
};

const PROFILE: ResolvedLlmPromptProfile = {
  id: "test-bot",
  companyName: "Test",
  forbiddenTopics: [],
  scopeText: "",
};

interface StoredMessage {
  id: string;
  conversationId: string;
  role: string;
  text: string;
  createdAt: Date;
}

interface Harness {
  service: DialogService;
  messages: StoredMessage[];
  messageCreate: ReturnType<typeof vi.fn>;
  llmComplete: ReturnType<typeof vi.fn>;
  llmCompleteWithTools: ReturnType<typeof vi.fn>;
  scriptStep: ReturnType<typeof vi.fn>;
  snippetMatch: ReturnType<typeof vi.fn>;
}

interface HarnessOverrides {
  bot?: Partial<ResolvedBotConfiguration>;
  rateLimit?: SafetyInResult;
  burst?: SafetyInResult;
  repeat?: SafetyInResult;
  content?: SafetyInResult;
  fsm?: ScriptStepOutcome;
  snippet?: SnippetHit | undefined;
  llmEnabled?: boolean;
  llmResult?: LlmCompleteResult | null;
}

function makeHarness(o: HarnessOverrides = {}): Harness {
  const bot: ResolvedBotConfiguration = { ...BOT, ...o.bot };
  const messages: StoredMessage[] = [];
  let seq = 0;

  const messageCreate = vi.fn(
    async ({ data }: { data: Omit<StoredMessage, "id" | "createdAt"> }) => {
      const row: StoredMessage = {
        id: `m${++seq}`,
        createdAt: new Date(2026, 0, 1, 0, 0, seq),
        ...data,
      };
      messages.push(row);
      return row;
    },
  );

  const prisma = {
    user: {
      findFirst: vi.fn(async () => ({ id: "u1", channel: "telegram", externalId: "42" })),
      create: vi.fn(async () => ({ id: "u1", channel: "telegram", externalId: "42" })),
    },
    conversation: {
      findFirst: vi.fn(async () => ({
        id: "c1",
        userId: "u1",
        stage: "contact",
        status: "ACTIVE",
        createdAt: new Date(2026, 0, 1),
      })),
      create: vi.fn(async () => ({ id: "c1", userId: "u1", stage: "contact", status: "ACTIVE" })),
      update: vi.fn(async () => undefined),
    },
    message: {
      create: messageCreate,
      findMany: vi.fn(async ({ take }: { take: number }) =>
        [...messages].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take),
      ),
    },
  };

  const llmComplete = vi.fn(async () =>
    o.llmResult === undefined ? { text: "LLM_OK" } : o.llmResult,
  );
  const llmCompleteWithTools = vi.fn(async () =>
    o.llmResult === undefined ? { text: "LLM_OK" } : o.llmResult,
  );
  const llmService = {
    isEnabled: vi.fn(() => o.llmEnabled ?? true),
    complete: llmComplete,
    completeWithTools: llmCompleteWithTools,
  };

  const promptProfile = { resolveProfileForBot: vi.fn(() => PROFILE) };
  const botConfiguration = { get: vi.fn(() => bot) };
  const ragService = { isInitialized: vi.fn(() => false), search: vi.fn(async () => []) };

  const snippetMatch = vi.fn(() => o.snippet);
  const snippetMatcher = { match: snippetMatch };

  const botUsage = {
    recordSafetyBlock: vi.fn(async () => undefined),
    recordFsm: vi.fn(async () => undefined),
    recordSnippet: vi.fn(async () => undefined),
    recordLlm: vi.fn(async () => undefined),
    recordNoLlmFallback: vi.fn(async () => undefined),
  };

  const skills = {
    resolveForBot: vi.fn(() => []),
    toToolSpec: vi.fn((s: unknown) => s),
    get: vi.fn(() => undefined),
  };

  const scriptStep = vi.fn(async () => o.fsm ?? ({ handled: false } as ScriptStepOutcome));
  const scriptRunner = { step: scriptStep };

  const safetyIn = {
    checkRateLimit: vi.fn(async () => o.rateLimit ?? ({ blocked: false } as SafetyInResult)),
    checkBurst: vi.fn(async () => o.burst ?? ({ blocked: false } as SafetyInResult)),
    checkRepeat: vi.fn(async () => o.repeat ?? ({ blocked: false } as SafetyInResult)),
    checkContent: vi.fn(() => o.content ?? ({ blocked: false } as SafetyInResult)),
  };

  const safetyOut = new SafetyOutService();

  // Компакция выключена в этих кейсах (BOT.llm.compaction отсутствует), поэтому
  // compose не вызывается — достаточно пустышки.
  const contextCompaction = { compose: vi.fn() };

  const service = new DialogService(
    prisma as never,
    llmService as never,
    promptProfile as never,
    botConfiguration as never,
    ragService as never,
    snippetMatcher as never,
    botUsage as never,
    skills as never,
    scriptRunner as never,
    safetyIn as never,
    safetyOut,
    contextCompaction as never,
  );

  return {
    service,
    messages,
    messageCreate,
    llmComplete,
    llmCompleteWithTools,
    scriptStep,
    snippetMatch,
  };
}

const INPUT = { channel: "telegram" as const, externalUserId: "42", text: "привет" };
const roles = (h: Harness) => h.messages.map((m) => m.role);

describe("DialogService.process cascade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rate-limit blocks before persisting the client message", async () => {
    const h = makeHarness({ rateLimit: { blocked: true, reply: "RL", category: "rate_limit" } });
    const out = await h.service.process(INPUT);
    expect(out.replyText).toBe("RL");
    expect(h.messages).toHaveLength(0); // блок ДО записи в БД
  });

  it("burst block (non-silent) returns the burst reply", async () => {
    const h = makeHarness({ burst: { blocked: true, reply: "BURST", category: "burst" } });
    const out = await h.service.process(INPUT);
    expect(out.replyText).toBe("BURST");
  });

  it("burst block (silent) returns empty text", async () => {
    const h = makeHarness({
      burst: { blocked: true, reply: "X", category: "burst", silent: true },
    });
    const out = await h.service.process(INPUT);
    expect(out.replyText).toBe("");
  });

  it("repeat block persists client message then assistant reply", async () => {
    const h = makeHarness({ repeat: { blocked: true, reply: "REP", category: "repeat" } });
    const out = await h.service.process(INPUT);
    expect(out.replyText).toBe("REP");
    expect(roles(h)).toEqual(["client", "assistant"]);
  });

  it("content-safety injection block short-circuits before FSM", async () => {
    const h = makeHarness({ content: { blocked: true, reply: "SAFE", category: "injection" } });
    const out = await h.service.process(INPUT);
    expect(out.replyText).toBe("SAFE");
    expect(h.scriptStep).not.toHaveBeenCalled();
    expect(roles(h)).toEqual(["client", "assistant"]);
  });

  it("FSM handled reply wins over snippet/LLM", async () => {
    const h = makeHarness({
      fsm: { handled: true, reply: "FSM", terminal: false, scriptName: "booking" },
    });
    const out = await h.service.process(INPUT);
    expect(out.replyText).toBe("FSM");
    expect(h.snippetMatch).not.toHaveBeenCalled();
    expect(h.llmComplete).not.toHaveBeenCalled();
  });

  it("snippet hit replies without calling the LLM", async () => {
    const h = makeHarness({ snippet: { id: "s1", reply: "SNIP" } });
    const out = await h.service.process(INPUT);
    expect(out.replyText).toBe("SNIP");
    expect(h.llmComplete).not.toHaveBeenCalled();
  });

  it("LLM reply is persisted on success", async () => {
    const h = makeHarness({ llmResult: { text: "HELLO" } });
    const out = await h.service.process(INPUT);
    expect(out.replyText).toBe("HELLO");
    expect(roles(h)).toEqual(["client", "assistant"]);
  });

  it("degraded LLM reply (null) falls back and is NOT persisted to history", async () => {
    const h = makeHarness({ llmResult: null });
    const out = await h.service.process(INPUT);
    expect(out.replyText).toBe(BOT.guardrails!.llmFallbackReply);
    expect(roles(h)).toEqual(["client"]); // assistant fallback не сохранён
  });

  it("safety-out caps an over-long LLM reply", async () => {
    const long = "x".repeat(50);
    const h = makeHarness({
      bot: { guardrails: { maxReplyChars: 10 } },
      llmResult: { text: long },
    });
    const out = await h.service.process(INPUT);
    expect(out.replyText.length).toBe(10);
    expect(out.replyText.endsWith("…")).toBe(true);
  });

  it("FSM llmNote bypasses snippet matching and routes to the LLM", async () => {
    const h = makeHarness({
      fsm: { handled: false, llmNote: "CONTEXT: собрано имя" },
      snippet: { id: "s1", reply: "SNIP" },
      llmResult: { text: "MANAGED" },
    });
    const out = await h.service.process(INPUT);
    expect(out.replyText).toBe("MANAGED");
    expect(h.snippetMatch).not.toHaveBeenCalled();
  });
});
