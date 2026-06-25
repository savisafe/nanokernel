import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClientService } from "./mcp-client.service";
import { SkillsRegistry } from "../skills/skills-registry.service";
import type { Skill, SkillCapability, SkillContext, SkillTrust } from "../skills/skill.contract";

/**
 * End-to-end (без LLM): реальный MCP-сервер `dev` поднимается по stdio, его
 * инструменты импортируются как Skill, прогоняются через реестр и диспетчер с
 * боевой политикой бота `ai-programmer` (allowlist + trust + capabilities).
 *
 * Доказывает всю цепочку платформы: MCP discovery → namespacing → реестр →
 * trust/capability-гейтинг → execute → MCP callTool → результат. Единственное,
 * что здесь не участвует, — выбор инструмента самой LLM.
 */
describe("MCP dev pack — end-to-end through registry + policy", () => {
  const projectRoot = process.cwd();
  const mcp = new McpClientService();
  let registry: SkillsRegistry;
  let skills: Skill[];

  const cfg = JSON.parse(
    readFileSync(path.join(projectRoot, "config/ai-programmer/configuration.json"), "utf8"),
  ) as {
    skills: string[];
    guardrails: { allowedSkillTrust: SkillTrust[]; allowedCapabilities: SkillCapability[] };
  };
  const CTX: SkillContext = { botId: "ai-programmer", channel: "http" };
  let tmpDir: string;

  beforeAll(async () => {
    // Тест проверяет цепочку платформы на dev-паке, поэтому поднимает сервер
    // НАТИВНО и джейльнутым в репозиторий через эфемерный конфиг — независимо
    // от продакшн config/mcp.json (он может быть Docker-песочницей с чужим
    // workspace). Так тест не требует Docker и не зависит от машинных путей.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "nk-mcp-it-"));
    const cfgFile = path.join(tmpDir, "mcp.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        mcpServers: {
          dev: {
            command: "node",
            args: [path.join(projectRoot, "packs/dev/index.mjs")],
            env: { DEV_WORKSPACE_ROOT: projectRoot },
            trust: "third-party",
          },
        },
      }),
    );
    process.env.MCP_CONFIG = cfgFile;
    skills = await mcp.loadSkills();
    registry = new SkillsRegistry(skills);
  }, 30_000);

  afterAll(async () => {
    await mcp.onModuleDestroy();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers and namespaces the dev server tools", () => {
    const names = skills.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "mcp:dev:list_dir",
        "mcp:dev:read_file",
        "mcp:dev:write_file",
        "mcp:dev:run_shell",
        "mcp:dev:search_code",
        "mcp:dev:git_status",
      ]),
    );
    // trust «штампуется» из mcp.json (сервер third-party).
    expect(skills.find((s) => s.name === "mcp:dev:run_shell")?.trust).toBe("third-party");
  });

  it("runs a tool through the bot's allowlist + trust + capability policy", async () => {
    const allowed = registry.resolveForBot(cfg.skills);
    const dispatch = registry.makeDispatcher(allowed, CTX, {
      allowedTrust: cfg.guardrails.allowedSkillTrust,
      allowedCapabilities: cfg.guardrails.allowedCapabilities,
    });

    const listing = await dispatch("mcp:dev:list_dir", { path: "src/modules" });
    expect(JSON.stringify(listing)).toContain("dialog");

    const shell = await dispatch("mcp:dev:run_shell", { command: "node -v" });
    expect(JSON.stringify(shell)).toMatch(/v\d+\.\d+\.\d+/);
  }, 30_000);

  it("blocks a write/network tool when the deployment only allows read", async () => {
    const allowed = registry.resolveForBot(cfg.skills);
    const readOnly = registry.makeDispatcher(allowed, CTX, {
      allowedTrust: cfg.guardrails.allowedSkillTrust,
      allowedCapabilities: ["read"],
    });
    const blocked = await readOnly("mcp:dev:run_shell", { command: "node -v" });
    expect(blocked).toMatchObject({ error: expect.stringContaining("capability policy") });
  }, 30_000);
});
