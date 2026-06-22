import { describe, it, expect, vi } from "vitest";
import { ContextCompactionService } from "./context-compaction.service";
import { getLanguagePack } from "../language/language-registry";
import type { LlmChatMessage } from "../llm/llm-provider.contract";

const STRINGS = getLanguagePack("ru").compaction;

function history(n: number): LlmChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg ${i}`,
  }));
}

describe("ContextCompactionService.compose", () => {
  it("returns history unchanged when within keepRecent", async () => {
    const llm = { complete: vi.fn() };
    const svc = new ContextCompactionService(llm as never);
    const h = history(4);
    const out = await svc.compose({
      history: h,
      keepRecent: 8,
      maxSummaryTokens: 256,
      strings: STRINGS,
    });
    expect(out.history).toEqual(h);
    expect(out.summaryNote).toBeUndefined();
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("summarizes the overflow and keeps the recent window verbatim", async () => {
    const llm = {
      complete: vi.fn(async (_messages: LlmChatMessage[]) => ({ text: "СВОДКА" })),
    };
    const svc = new ContextCompactionService(llm as never);
    const h = history(10);
    const out = await svc.compose({
      history: h,
      keepRecent: 4,
      maxSummaryTokens: 200,
      strings: STRINGS,
    });
    expect(out.history).toHaveLength(4);
    expect(out.history).toEqual(h.slice(6)); // последние 4 дословно
    expect(out.summaryNote).toBe(`${STRINGS.summaryNotePrefix}\nСВОДКА`);
    // суммаризатор получил транскрипт старых 6 сообщений с языковыми метками
    const sentUser = String(llm.complete.mock.calls[0]?.[0]?.[1]?.content ?? "");
    expect(sentUser).toContain(`${STRINGS.clientLabel}:`);
    expect(sentUser).toContain("msg 0");
    expect(sentUser).not.toContain("msg 6");
  });

  it("falls back to plain truncation when summarization fails", async () => {
    const llm = { complete: vi.fn(async () => null) };
    const svc = new ContextCompactionService(llm as never);
    const h = history(10);
    const out = await svc.compose({
      history: h,
      keepRecent: 3,
      maxSummaryTokens: 200,
      strings: STRINGS,
    });
    expect(out.history).toEqual(h.slice(7));
    expect(out.summaryNote).toBeUndefined();
  });
});
