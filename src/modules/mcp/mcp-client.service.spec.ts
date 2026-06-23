import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  deriveCapabilities,
  normalizeResult,
  wrapMcpTool,
  type McpTool,
} from "./mcp-client.service";
import type { SkillContext } from "../skills/skill.contract";

const CTX: SkillContext = { botId: "b1", conversationId: "c1", channel: "http" };

describe("MCP tool → Skill wrapping (real in-memory roundtrip)", () => {
  it("lists a server tool, wraps it, and executes it end-to-end", async () => {
    // Реальный MCP-сервер с одним инструментом.
    const server = new McpServer({ name: "fixture", version: "1.0.0" });
    server.registerTool(
      "echo",
      {
        description: "Echo back the message.",
        inputSchema: { message: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
    );

    // Связываем клиент и сервер in-memory транспортом.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = (await client.listTools()) as { tools: McpTool[] };
    expect(listed.tools.map((t) => t.name)).toContain("echo");

    const tool = listed.tools.find((t) => t.name === "echo")!;
    const skill = wrapMcpTool("dev", tool, client, "third-party", ["read"]);

    // Имя неймспейснуто, метаданные проброшены.
    expect(skill.name).toBe("mcp:dev:echo");
    expect(skill.trust).toBe("third-party");
    expect(skill.description).toContain("Echo");

    // Вызов реально проходит через MCP-сервер и нормализуется.
    const result = await skill.execute({ message: "hi" }, CTX);
    expect(result).toEqual({ data: { text: "echo: hi" } });

    await client.close();
  });
});

describe("normalizeResult", () => {
  it("prefers structuredContent", () => {
    expect(normalizeResult({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
  });

  it("joins text parts", () => {
    expect(
      normalizeResult({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toEqual({ text: "a\nb" });
  });

  it("maps isError to an error object", () => {
    expect(normalizeResult({ content: [{ type: "text", text: "boom" }], isError: true })).toEqual({
      error: "boom",
    });
  });
});

describe("deriveCapabilities", () => {
  it("returns undefined without annotations", () => {
    expect(deriveCapabilities({ name: "x" })).toBeUndefined();
  });

  it("readOnlyHint → read only", () => {
    expect(deriveCapabilities({ name: "x", annotations: { readOnlyHint: true } })).toEqual([
      "read",
    ]);
  });

  it("non-readonly → read+write; openWorld → +network", () => {
    expect(
      deriveCapabilities({ name: "x", annotations: { readOnlyHint: false, openWorldHint: true } }),
    ).toEqual(["read", "write", "network"]);
  });
});
