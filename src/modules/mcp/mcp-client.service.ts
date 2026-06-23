import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DEFAULT_MCP_CAPABILITIES,
  DEFAULT_MCP_TRUST,
  isRemoteServer,
  loadMcpConfig,
  type McpServerConfig,
} from "./mcp-servers.types";
import type {
  Skill,
  SkillCapability,
  SkillContext,
  SkillResult,
  SkillTrust,
} from "../skills/skill.contract";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** Минимально необходимая форма MCP-инструмента из tools/list. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** Минимально необходимая форма результата tools/call. */
interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * MCP-клиент: на старте подключается к серверам из `mcp.json`, делает tools/list
 * и оборачивает каждый инструмент в наш `Skill` (имя `mcp:<server>:<tool>`).
 * Эти скиллы вливаются в `SKILL_PROVIDERS_TOKEN` наравне с builtin — реестр,
 * dispatcher, FSM и trust/capability-гейтинг работают для них без правок.
 *
 * Устойчивость: недоступный/битый сервер логируется и пропускается, boot не
 * падает (per-server try/catch + таймаут на connect/list). Транспорты
 * закрываются на shutdown.
 */
@Injectable()
export class McpClientService implements OnModuleDestroy {
  private readonly logger = new Logger(McpClientService.name);
  private readonly clients: Client[] = [];
  private loaded = false;

  /** Подключиться ко всем серверам и вернуть их инструменты как Skill[]. Идемпотентно. */
  async loadSkills(): Promise<Skill[]> {
    if (this.loaded) {
      return [];
    }
    this.loaded = true;

    let servers: Record<string, McpServerConfig>;
    try {
      servers = loadMcpConfig().mcpServers;
    } catch (e) {
      this.logger.error(`MCP config invalid — skipping all MCP servers: ${errMsg(e)}`);
      return [];
    }

    const names = Object.keys(servers);
    if (names.length === 0) {
      this.logger.log("No MCP servers configured.");
      return [];
    }

    const all: Skill[] = [];
    for (const name of names) {
      const server = servers[name];
      if (server.disabled) {
        this.logger.log(`MCP server "${name}" disabled — skipping.`);
        continue;
      }
      try {
        const skills = await this.connectServer(name, server);
        all.push(...skills);
        this.logger.log(`MCP server "${name}" connected: ${skills.length} tools`);
      } catch (e) {
        this.logger.error(`MCP server "${name}" failed to connect — skipping: ${errMsg(e)}`);
      }
    }
    return all;
  }

  private async connectServer(name: string, server: McpServerConfig): Promise<Skill[]> {
    const timeout = server.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const transport = isRemoteServer(server)
      ? new StreamableHTTPClientTransport(
          new URL(server.url),
          server.headers ? { requestInit: { headers: server.headers } } : undefined,
        )
      : new StdioClientTransport({
          command: server.command,
          args: server.args,
          cwd: server.cwd,
          env: { ...getDefaultEnvironment(), ...(server.env ?? {}) },
        });

    const client = new Client({ name: `nanokernel-${name}`, version: "1.0.0" });
    await withTimeout(client.connect(transport), timeout, `connect "${name}"`);
    this.clients.push(client);

    const listed = (await withTimeout(client.listTools(), timeout, `listTools "${name}"`)) as {
      tools: McpTool[];
    };
    const trust: SkillTrust = server.trust ?? DEFAULT_MCP_TRUST;
    return listed.tools.map((tool) => this.wrapTool(name, tool, client, server, trust));
  }

  private wrapTool(
    serverName: string,
    tool: McpTool,
    client: Client,
    server: McpServerConfig,
    trust: SkillTrust,
  ): Skill {
    const capabilities = server.capabilities ??
      deriveCapabilities(tool) ?? [...DEFAULT_MCP_CAPABILITIES];
    return wrapMcpTool(serverName, tool, client, trust, capabilities);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.close()));
  }
}

/** Минимально необходимая для вызова инструмента часть Client (упрощает тесты). */
export interface ToolCaller {
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<unknown>;
}

/** Обернуть один MCP-инструмент в наш Skill (`mcp:<server>:<tool>`). */
export function wrapMcpTool(
  serverName: string,
  tool: McpTool,
  client: ToolCaller,
  trust: SkillTrust,
  capabilities: SkillCapability[],
): Skill {
  const toolName = tool.name;
  return {
    name: `mcp:${serverName}:${toolName}`,
    description: tool.description ?? `MCP tool "${toolName}" from server "${serverName}".`,
    parameters: tool.inputSchema ?? { type: "object", properties: {} },
    trust,
    capabilities,
    async execute(args: Record<string, unknown>, _ctx: SkillContext): Promise<SkillResult> {
      const res = (await client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: DEFAULT_CALL_TIMEOUT_MS,
      })) as McpCallResult;
      return { data: normalizeResult(res) };
    },
  };
}

/** read-only инструмент → ["read"]; иначе добавляем write; openWorld → network. */
export function deriveCapabilities(tool: McpTool): SkillCapability[] | undefined {
  const a = tool.annotations;
  if (!a) {
    return undefined;
  }
  const caps = new Set<SkillCapability>(["read"]);
  if (a.readOnlyHint !== true) {
    caps.add("write");
  }
  if (a.openWorldHint === true) {
    caps.add("network");
  }
  return [...caps];
}

/** Сводим MCP-результат к данным для LLM: structured > текст; isError → {error}. */
export function normalizeResult(res: McpCallResult): unknown {
  if (res.structuredContent !== undefined) {
    return res.structuredContent;
  }
  const parts = Array.isArray(res.content) ? res.content : [];
  const text = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
  if (res.isError) {
    return { error: text || "MCP tool returned an error" };
  }
  return text.length > 0 ? { text } : { content: parts };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      const handle = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      handle.unref?.();
    }),
  ]);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
