import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PROVIDER_ENV, ALL_PROVIDERS, isLocalProvider, presentKeys, detectProvider, hasKey } from "../cli/env.js";

describe("PROVIDER_ENV", () => {
  it("has the expected key-based providers", () => {
    expect(PROVIDER_ENV).toHaveProperty("anthropic");
    expect(PROVIDER_ENV).toHaveProperty("gemini");
    expect(PROVIDER_ENV).toHaveProperty("groq");
  });

  it("maps to correct env var names", () => {
    expect(PROVIDER_ENV.anthropic).toBe("ANTHROPIC_API_KEY");
    expect(PROVIDER_ENV.gemini).toBe("GEMINI_API_KEY");
    expect(PROVIDER_ENV.groq).toBe("GROQ_API_KEY");
  });

  it("excludes keyless local providers (ollama has no env var)", () => {
    expect(PROVIDER_ENV).not.toHaveProperty("ollama");
  });
});

describe("ALL_PROVIDERS / isLocalProvider", () => {
  it("lists every supported provider, including keyless ollama", () => {
    expect(ALL_PROVIDERS).toEqual(["anthropic", "gemini", "groq", "ollama"]);
  });

  it("marks only ollama as local", () => {
    expect(isLocalProvider("ollama")).toBe(true);
    expect(isLocalProvider("anthropic")).toBe(false);
    expect(isLocalProvider("groq")).toBe(false);
  });
});

describe("presentKeys", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns providers with set keys", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const keys = presentKeys();
    expect(keys).toContain("anthropic");
  });

  it("returns empty array when no keys set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    const keys = presentKeys();
    expect(keys).toEqual([]);
  });
});

describe("detectProvider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns first provider with a key", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect(detectProvider()).toBe("anthropic");
  });

  it("returns null when no keys set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    expect(detectProvider()).toBeNull();
  });
});

describe("hasKey", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns true when key exists", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect(hasKey("anthropic")).toBe(true);
  });

  it("returns false when key missing", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(hasKey("anthropic")).toBe(false);
  });
});
