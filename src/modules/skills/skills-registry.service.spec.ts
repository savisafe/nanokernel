import { describe, it, expect, vi } from "vitest";
import { SkillsRegistry } from "./skills-registry.service";
import type { Skill, SkillContext } from "./skill.contract";

function skill(name: string, extra: Partial<Skill> = {}): Skill {
  return {
    name,
    description: `desc ${name}`,
    parameters: {},
    execute: vi.fn(async () => ({ data: { ran: name } })),
    ...extra,
  };
}

const CTX: SkillContext = { botId: "b1", conversationId: "c1", channel: "telegram" };

describe("SkillsRegistry.makeDispatcher trust gate", () => {
  it("executes a skill that is in the enabled set", async () => {
    const a = skill("a");
    const reg = new SkillsRegistry([a]);
    const dispatch = reg.makeDispatcher([a], CTX);
    const out = await dispatch("a", { x: 1 });
    expect(out).toEqual({ ran: "a" });
    expect(a.execute).toHaveBeenCalledWith({ x: 1 }, CTX);
  });

  it("refuses a skill outside the bot's enabled set even if globally registered", async () => {
    const a = skill("a");
    const b = skill("b"); // зарегистрирован, но НЕ включён для бота
    const reg = new SkillsRegistry([a, b]);
    const dispatch = reg.makeDispatcher([a], CTX); // включён только a
    const out = await dispatch("b", {});
    expect(out).toMatchObject({ error: expect.stringContaining("not enabled") });
    expect(b.execute).not.toHaveBeenCalled();
  });

  it("blocks a skill whose trust is not allowed by the deployment policy", async () => {
    const community = skill("c", { trust: "community" });
    const reg = new SkillsRegistry([community]);
    const dispatch = reg.makeDispatcher([community], CTX, { allowedTrust: ["builtin"] });
    const out = await dispatch("c", {});
    expect(out).toMatchObject({ error: expect.stringContaining("trust policy") });
    expect(community.execute).not.toHaveBeenCalled();
  });

  it("allows a matching trust tier and fires onExecute", async () => {
    const builtin = skill("bi"); // trust по умолчанию = builtin
    const reg = new SkillsRegistry([builtin]);
    const onExecute = vi.fn();
    const dispatch = reg.makeDispatcher([builtin], CTX, { allowedTrust: ["builtin"], onExecute });
    await dispatch("bi", {});
    expect(builtin.execute).toHaveBeenCalled();
    expect(onExecute).toHaveBeenCalledWith("bi");
  });

  it("defaults missing trust to builtin", () => {
    const reg = new SkillsRegistry([]);
    expect(reg.trustOf(skill("x"))).toBe("builtin");
    expect(reg.trustOf(skill("y", { trust: "third-party" }))).toBe("third-party");
  });

  it("blocks a skill whose capability is outside the allowed set", async () => {
    const writer = skill("w", { capabilities: ["read", "write"] });
    const reg = new SkillsRegistry([writer]);
    const dispatch = reg.makeDispatcher([writer], CTX, { allowedCapabilities: ["read"] });
    const out = await dispatch("w", {});
    expect(out).toMatchObject({ error: expect.stringContaining("capability policy") });
    expect(writer.execute).not.toHaveBeenCalled();
  });

  it("allows a skill whose capabilities are within the allowed set", async () => {
    const reader = skill("r", { capabilities: ["read"] });
    const reg = new SkillsRegistry([reader]);
    const dispatch = reg.makeDispatcher([reader], CTX, { allowedCapabilities: ["read", "write"] });
    const out = await dispatch("r", {});
    expect(out).toEqual({ ran: "r" });
    expect(reader.execute).toHaveBeenCalled();
  });
});
