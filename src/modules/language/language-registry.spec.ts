import { describe, it, expect } from "vitest";
import { getLanguagePack, registerLanguagePack, availableLanguages } from "./language-registry";
import type { LanguagePack } from "./language-pack.types";

describe("language registry", () => {
  it("resolves ru exactly and by BCP-47 base", () => {
    expect(getLanguagePack("ru").code).toBe("ru");
    expect(getLanguagePack("ru-RU").code).toBe("ru");
  });

  it("falls back to the default pack for unknown / empty codes", () => {
    expect(getLanguagePack(undefined).code).toBe("ru");
    expect(getLanguagePack("xx").code).toBe("ru");
  });

  it("ru pack normalizes ё→е and lowercases", () => {
    expect(getLanguagePack("ru").normalize("ЗабЁг")).toBe("забег");
  });

  it("allows registering an additional pack", () => {
    const fake: LanguagePack = {
      ...getLanguagePack("ru"),
      code: "xx",
    };
    registerLanguagePack(fake);
    expect(getLanguagePack("xx").code).toBe("xx");
    expect(availableLanguages()).toContain("xx");
  });
});
