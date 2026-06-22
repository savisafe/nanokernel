import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LlmService } from "./llm.service";
import type { LlmProvider, ProviderChatChoice, ProviderChatRequest } from "./llm-provider.contract";

/**
 * Тесты ОРКЕСТРАЦИИ LlmService с фейковым провайдером: enabled-флаг, «пустой текст → null»,
 * tool-loop с диспатчем, force-retry без tools. Транспорт (HTTP/SSE) — забота провайдера и
 * здесь не участвует.
 */

function providerOf(...choices: (ProviderChatChoice | null)[]): {
  provider: LlmProvider;
  calls: ProviderChatRequest[];
} {
  const calls: ProviderChatRequest[] = [];
  let i = 0;
  const provider: LlmProvider = {
    id: "fake",
    chat: vi.fn(async (req: ProviderChatRequest) => {
      calls.push(req);
      return choices[Math.min(i++, choices.length - 1)] ?? null;
    }),
  };
  return { provider, calls };
}

describe("LlmService orchestration", () => {
  beforeEach(() => {
    process.env.LLM_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.LLM_ENABLED;
  });

  it("returns null when LLM disabled", async () => {
    delete process.env.LLM_ENABLED;
    const { provider } = providerOf({ text: "hi" });
    const svc = new LlmService(provider);
    expect(await svc.complete([{ role: "user", content: "x" }])).toBeNull();
  });

  it("maps an empty-text choice to null", async () => {
    const { provider } = providerOf({ text: undefined, finishReason: "length" });
    const svc = new LlmService(provider);
    expect(await svc.complete([{ role: "user", content: "x" }])).toBeNull();
  });

  it("returns the text on success", async () => {
    const { provider } = providerOf({ text: "hello", model: "m" });
    const svc = new LlmService(provider);
    const out = await svc.complete([{ role: "user", content: "x" }]);
    expect(out?.text).toBe("hello");
  });

  it("runs the tool loop: dispatch then final text", async () => {
    const { provider, calls } = providerOf(
      {
        toolCalls: [
          { id: "t1", type: "function", function: { name: "lookup", arguments: '{"q":1}' } },
        ],
        usage: { promptTokens: 10, completionTokens: 2 },
      },
      { text: "answer", usage: { promptTokens: 5, completionTokens: 3 } },
    );
    const svc = new LlmService(provider);
    const dispatch = vi.fn(async () => ({ ok: true }));
    const out = await svc.completeWithTools(
      [{ role: "user", content: "x" }],
      undefined,
      [{ name: "lookup", description: "d", parameters: {} }],
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledWith("lookup", { q: 1 });
    expect(out?.text).toBe("answer");
    expect(out?.usage).toEqual({ promptTokens: 15, completionTokens: 5 });
    // второй запрос идёт после tool-результата с накопленными сообщениями
    expect(calls[1].messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("force-retries without tools when the tool turn yields empty text", async () => {
    const { provider, calls } = providerOf(
      { text: undefined, finishReason: "length" }, // пустой ход с tools
      { text: "recovered" }, // force-retry без tools
    );
    const svc = new LlmService(provider);
    const out = await svc.completeWithTools(
      [{ role: "user", content: "x" }],
      undefined,
      [{ name: "lookup", description: "d", parameters: {} }],
      vi.fn(async () => ({})),
    );
    expect(out?.text).toBe("recovered");
    expect(calls[calls.length - 1].tools).toBeUndefined(); // последний запрос — без tools
  });

  it("delegates to complete() when tools list is empty", async () => {
    const { provider, calls } = providerOf({ text: "plain" });
    const svc = new LlmService(provider);
    const out = await svc.completeWithTools(
      [{ role: "user", content: "x" }],
      undefined,
      [],
      vi.fn(),
    );
    expect(out?.text).toBe("plain");
    expect(calls[0].tools).toBeUndefined();
  });
});
