#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * dev — кастомный MCP-сервер пака "ИИ-программист".
 *
 * Экспонирует базовые dev-инструменты (файлы, shell, поиск, git) по стандарту
 * Model Context Protocol, поэтому переиспользуется в любом MCP-клиенте
 * (nanokernel, Claude Desktop, Cursor, IDE), а не только здесь.
 *
 * Безопасность: все файловые/shell-операции ДЖЕЙЛЯТСЯ в рабочем каталоге
 * (`DEV_WORKSPACE_ROOT`, по умолчанию cwd). Путь вне джейла → отказ. Деструктивные
 * инструменты помечены MCP-аннотациями (destructiveHint), а на стороне платформы
 * гейтятся trust/capability-политикой бота.
 *
 * Транспорт — stdio: платформа поднимает сервер как дочерний процесс.
 * SDK резолвится из корневого node_modules проекта (отдельная сборка не нужна).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const WORKSPACE_ROOT = path.resolve(process.env.DEV_WORKSPACE_ROOT ?? process.cwd());
const MAX_FILE_BYTES = 200_000;
const MAX_OUTPUT_CHARS = 20_000;
const SHELL_TIMEOUT_MS = 30_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".understand-anything"]);
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".sql",
  ".prisma",
  ".env",
  ".sh",
  ".css",
  ".html",
]);

/** Резолвит путь относительно джейла и проверяет, что он не выходит за его пределы. */
function safeResolve(rel) {
  const resolved = path.resolve(WORKSPACE_ROOT, rel ?? ".");
  const withSep = WORKSPACE_ROOT.endsWith(path.sep) ? WORKSPACE_ROOT : WORKSPACE_ROOT + path.sep;
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(withSep)) {
    throw new Error(`path "${rel}" escapes the workspace jail`);
  }
  return resolved;
}

function ok(text) {
  return { content: [{ type: "text", text: String(text).slice(0, MAX_OUTPUT_CHARS) }] };
}
function fail(message) {
  return { isError: true, content: [{ type: "text", text: `error: ${message}` }] };
}

const server = new McpServer({ name: "dev", version: "0.1.0" });

server.registerTool(
  "list_dir",
  {
    description: "List entries (files and directories) of a directory within the workspace.",
    inputSchema: { path: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ path: rel }) => {
    try {
      const dir = safeResolve(rel);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const lines = entries
        .filter((e) => !SKIP_DIRS.has(e.name))
        .map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`)
        .sort();
      return ok(lines.join("\n") || "(empty)");
    } catch (e) {
      return fail(e.message);
    }
  },
);

server.registerTool(
  "read_file",
  {
    description: "Read a UTF-8 text file within the workspace (truncated to 200 KB).",
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ path: rel }) => {
    try {
      const file = safeResolve(rel);
      const buf = await fs.readFile(file);
      const text = buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
      return ok(text);
    } catch (e) {
      return fail(e.message);
    }
  },
);

server.registerTool(
  "write_file",
  {
    description: "Write (create or overwrite) a UTF-8 text file within the workspace.",
    inputSchema: { path: z.string(), content: z.string() },
    annotations: { destructiveHint: true },
  },
  async ({ path: rel, content }) => {
    try {
      const file = safeResolve(rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content, "utf8");
      return ok(`wrote ${content.length} chars to ${rel}`);
    } catch (e) {
      return fail(e.message);
    }
  },
);

server.registerTool(
  "run_shell",
  {
    description: "Run a shell command in the workspace root. Returns stdout/stderr/exit code.",
    inputSchema: { command: z.string(), timeoutMs: z.number().int().positive().optional() },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  async ({ command, timeoutMs }) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: WORKSPACE_ROOT,
        timeout: timeoutMs ?? SHELL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return ok(`exit 0\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
    } catch (e) {
      const code = typeof e.code === "number" ? e.code : 1;
      return ok(
        `exit ${code}\n--- stdout ---\n${e.stdout ?? ""}\n--- stderr ---\n${e.stderr ?? e.message}`,
      );
    }
  },
);

server.registerTool(
  "search_code",
  {
    description:
      "Search for a substring across text files in the workspace (skips node_modules/.git/dist).",
    inputSchema: {
      query: z.string(),
      path: z.string().optional(),
      maxResults: z.number().int().positive().optional(),
    },
  },
  async ({ query, path: rel, maxResults }) => {
    try {
      const root = safeResolve(rel);
      const cap = maxResults ?? 100;
      const hits = [];
      async function walk(dir) {
        if (hits.length >= cap) return;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (hits.length >= cap) return;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name));
            continue;
          }
          if (!TEXT_EXT.has(path.extname(e.name))) continue;
          const full = path.join(dir, e.name);
          let text;
          try {
            text = await fs.readFile(full, "utf8");
          } catch {
            continue;
          }
          const relPath = path.relative(WORKSPACE_ROOT, full).replace(/\\/g, "/");
          text.split(/\r?\n/).forEach((line, i) => {
            if (hits.length < cap && line.includes(query)) {
              hits.push(`${relPath}:${i + 1}: ${line.trim().slice(0, 200)}`);
            }
          });
        }
      }
      await walk(root);
      return ok(hits.length ? hits.join("\n") : `no matches for "${query}"`);
    } catch (e) {
      return fail(e.message);
    }
  },
);

server.registerTool(
  "git_status",
  {
    description: "Show git status (porcelain + branch) for the workspace repository.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const { stdout } = await execAsync("git status --porcelain=v1 -b", {
        cwd: WORKSPACE_ROOT,
        timeout: SHELL_TIMEOUT_MS,
        windowsHide: true,
      });
      return ok(stdout || "(clean)");
    } catch (e) {
      return fail(e.stderr ?? e.message);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr — единственный безопасный канал для логов (stdout занят MCP-протоколом).
process.stderr.write(`[dev-mcp] ready; workspace=${WORKSPACE_ROOT}\n`);
