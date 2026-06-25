import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configRoot } from "../shared/config-paths";
import type { SkillCapability, SkillTrust } from "../skills/skill.contract";

/**
 * Конфигурация MCP-серверов — источник внешних скиллов (стандарт Model Context
 * Protocol). Формат намеренно повторяет привычный `mcpServers` из Claude/Cursor,
 * чтобы готовые серверы подключались копипастом.
 *
 * Два транспорта:
 *  - stdio  — локальный серверный процесс (`command` + `args`), напр. наш пак `dev`
 *             или публичный `npx @modelcontextprotocol/server-filesystem`;
 *  - remote — удалённый сервер по `url` (Streamable HTTP).
 *
 * `trust` и `capabilities` — security-метаданные сервера: они «штампуются» на
 * каждый импортированный из сервера скилл, и dispatcher гейтит по ним
 * (`guardrails.allowedSkillTrust` / `allowedCapabilities`). Код сервера не может
 * их расширить — авторитетен конфиг.
 *
 * Резолв файла: env `MCP_CONFIG` (путь) → `<configRoot>/mcp.json`.
 */

const trustSchema = z.enum(["builtin", "community", "third-party"]);
const capabilitySchema = z.enum(["read", "write", "network", "pii", "calendar"]);

const stdioServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  trust: trustSchema.optional(),
  capabilities: z.array(capabilitySchema).optional(),
  /** Таймаут на connect+tools/list, мс (по умолчанию 15000). */
  startupTimeoutMs: z.number().int().positive().optional(),
  /** Полностью отключить сервер, не удаляя из конфига. */
  disabled: z.boolean().optional(),
});

const remoteServerSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  trust: trustSchema.optional(),
  capabilities: z.array(capabilitySchema).optional(),
  startupTimeoutMs: z.number().int().positive().optional(),
  disabled: z.boolean().optional(),
});

const serverSchema = z.union([stdioServerSchema, remoteServerSchema]);

export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), serverSchema).default({}),
});

export type McpStdioServer = z.infer<typeof stdioServerSchema>;
export type McpRemoteServer = z.infer<typeof remoteServerSchema>;
export type McpServerConfig = z.infer<typeof serverSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

export function isRemoteServer(s: McpServerConfig): s is McpRemoteServer {
  return "url" in s;
}

export const DEFAULT_MCP_TRUST: SkillTrust = "third-party";
export const DEFAULT_MCP_CAPABILITIES: readonly SkillCapability[] = ["read", "write", "network"];

/** Путь к mcp.json. env `MCP_CONFIG` приоритетнее. */
export function resolveMcpConfigFile(): string {
  const override = process.env.MCP_CONFIG?.trim();
  if (override && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(configRoot(), "mcp.json");
}

/**
 * Рекурсивно подставляет `${VAR}` из process.env в строковые значения конфига.
 * Делается ПОСЛЕ JSON.parse, поэтому значение (напр. путь `C:\…`) может содержать
 * любые символы без оглядки на JSON-экранирование. Неизвестная/пустая переменная
 * → явная ошибка: лучше упасть, чем тихо собрать битый путь монтирования или URL.
 */
function expandEnvDeep(value: unknown, file: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const v = process.env[name];
      if (v === undefined || v === "") {
        throw new Error(`mcp.json at ${file} references env "${name}" which is not set`);
      }
      return v;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvDeep(v, file));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandEnvDeep(v, file)]),
    );
  }
  return value;
}

/**
 * Загружает и валидирует mcp.json. Файла нет → пустой конфиг (MCP опционален).
 * Битый JSON/схема → бросаем с понятным сообщением (явная ошибка лучше тихого
 * запуска без заявленных серверов). Строки поддерживают `${VAR}` из окружения.
 */
export function loadMcpConfig(): McpConfig {
  const file = resolveMcpConfigFile();
  if (!existsSync(file)) {
    return { mcpServers: {} };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`mcp.json at ${file} is not valid JSON: ${msg}`);
  }
  raw = expandEnvDeep(raw, file);
  const parsed = mcpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`mcp.json at ${file} failed validation: ${issues}`);
  }
  return parsed.data;
}
