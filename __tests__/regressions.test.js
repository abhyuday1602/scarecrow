// Regression tests for code-review fixes that don't fit an existing module's test file.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveModel } from "../cli/commands.js";
import { logger, setLogDir } from "../cli/logger.js";
import { compareRuns } from "../cli/diff.js";
import { markSessionComplete } from "../cli/resume.js";

describe("effectiveModel (a saved model only applies to its own provider)", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.MODEL; delete process.env.PROVIDER; });
  afterEach(() => { process.env = { ...saved }; });

  it("ignores a saved model that belongs to a different saved provider", () => {
    const cfg = { provider: "anthropic", model: "claude-sonnet-4-6" };
    expect(effectiveModel("gemini", { cfg, defaultModel: "gemini-2.5-flash" })).toBe("gemini-2.5-flash");
    expect(effectiveModel("anthropic", { cfg, defaultModel: "x" })).toBe("claude-sonnet-4-6");
  });

  it("applies MODEL only alongside its PROVIDER", () => {
    process.env.PROVIDER = "groq";
    process.env.MODEL = "some-groq-model";
    expect(effectiveModel("gemini", { defaultModel: "gemini-2.5-flash" })).toBe("gemini-2.5-flash");
    expect(effectiveModel("groq", { defaultModel: "d" })).toBe("some-groq-model");
  });

  it("always honours an explicit --model", () => {
    expect(effectiveModel("gemini", { flagModel: "gemini-2.5-pro", cfg: { provider: "anthropic", model: "c" }, defaultModel: "d" })).toBe("gemini-2.5-pro");
  });
});

describe("filesystem regressions", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "crow-reg-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("each run directory gets its own log file", () => {
    const a = join(dir, "a"), b = join(dir, "b");
    setLogDir(a); logger.log("ONE");
    setLogDir(b); logger.log("TWO");
    expect(readdirSync(join(a, "logs"))).toHaveLength(1);
    expect(readdirSync(join(b, "logs"))).toHaveLength(1);
    expect(readFileSync(join(b, "logs", readdirSync(join(b, "logs"))[0]), "utf8")).toMatch(/TWO/);
  });

  it("crow diff refuses a verdict for runs of different goals", () => {
    const write = (name, data) => { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, "findings.json"), JSON.stringify(data)); };
    const base = { url: "https://a.com", persona: "novice", goal: "sign up", findings: [{ severity: "high" }] };
    write("r1", base);
    write("r2", { ...base, goal: "find pricing", findings: [] });
    write("r3", { ...base, findings: [] });
    expect(compareRuns(join(dir, "r1"), join(dir, "r2"))).toMatchObject({ comparable: false, verdict: "not comparable" });
    expect(compareRuns(join(dir, "r1"), join(dir, "r3"))).toMatchObject({ comparable: true, verdict: "improved" });
  });

  it("a corrupt session-state.json doesn't throw when marking a run complete", () => {
    writeFileSync(join(dir, "session-state.json"), "{not json");
    expect(() => markSessionComplete(dir)).not.toThrow();
  });
});
