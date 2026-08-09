import { describe, it, expect } from "vitest";
import { SETTINGS, pick } from "../cli/config.js";

describe("SETTINGS", () => {
  it("has expected settings", () => {
    expect(SETTINGS).toHaveProperty("provider");
    expect(SETTINGS).toHaveProperty("model");
    expect(SETTINGS).toHaveProperty("persona");
    expect(SETTINGS).toHaveProperty("steps");
    expect(SETTINGS).toHaveProperty("headed");
    expect(SETTINGS).toHaveProperty("full");
    expect(SETTINGS).toHaveProperty("color");
  });

  it("each setting has a desc and coerce", () => {
    for (const [_key, setting] of Object.entries(SETTINGS)) {
      expect(setting.desc).toBeTruthy();
      expect(typeof setting.coerce).toBe("function");
    }
  });
});

describe("provider coerce", () => {
  it("accepts valid provider", () => {
    expect(SETTINGS.provider.coerce("anthropic")).toBe("anthropic");
    expect(SETTINGS.provider.coerce("gemini")).toBe("gemini");
    expect(SETTINGS.provider.coerce("groq")).toBe("groq");
    expect(SETTINGS.provider.coerce("ollama")).toBe("ollama");
  });

  it("rejects invalid provider", () => {
    expect(() => SETTINGS.provider.coerce("openai")).toThrow();
  });
});

describe("steps coerce", () => {
  it("accepts valid positive integer", () => {
    expect(SETTINGS.steps.coerce("8")).toBe(8);
    expect(SETTINGS.steps.coerce("1")).toBe(1);
  });

  it("rejects zero", () => {
    expect(() => SETTINGS.steps.coerce("0")).toThrow();
  });

  it("rejects negative", () => {
    expect(() => SETTINGS.steps.coerce("-1")).toThrow();
  });

  it("rejects non-integer", () => {
    expect(() => SETTINGS.steps.coerce("abc")).toThrow();
    expect(() => SETTINGS.steps.coerce("1.5")).toThrow();
  });
});

describe("headed coerce", () => {
  it("accepts true values", () => {
    expect(SETTINGS.headed.coerce("true")).toBe(true);
    expect(SETTINGS.headed.coerce("yes")).toBe(true);
    expect(SETTINGS.headed.coerce("on")).toBe(true);
    expect(SETTINGS.headed.coerce("1")).toBe(true);
  });

  it("accepts false values", () => {
    expect(SETTINGS.headed.coerce("false")).toBe(false);
    expect(SETTINGS.headed.coerce("no")).toBe(false);
    expect(SETTINGS.headed.coerce("off")).toBe(false);
    expect(SETTINGS.headed.coerce("0")).toBe(false);
  });

  it("rejects invalid values", () => {
    expect(() => SETTINGS.headed.coerce("maybe")).toThrow();
  });
});

describe("pick", () => {
  it("returns first defined value", () => {
    expect(pick(undefined, undefined, undefined, "default")).toBe("default");
    expect(pick("flag", undefined, undefined, "default")).toBe("flag");
    expect(pick(undefined, "env", undefined, "default")).toBe("env");
    expect(pick(undefined, undefined, "cfg", "default")).toBe("cfg");
  });

  it("returns undefined when all undefined", () => {
    expect(pick(undefined, undefined, undefined, undefined)).toBeUndefined();
  });
});
