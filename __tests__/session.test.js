// End-to-end run loop (cli/session.js runSession) against local fixture pages, with the
// model's replies scripted through llm.js cassette replay — a real browser, no network
// LLM calls, no API key. Skipped when Playwright's Chromium isn't installed.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { runSession } from "../cli/session.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const hasChromium = (() => { try { return existsSync(chromium.executablePath()); } catch { return false; } })();

// A reporter that swallows everything (the runs are asserted on via their artifacts).
const silent = new Proxy({}, {
  get: (_, name) => {
    if (["thinking", "reflecting", "looking"].includes(name)) return () => ({ chunk() {}, end() {} });
    if (name === "phase") return () => () => {};
    if (name === "onOutOfSteps") return undefined;
    return () => {};
  },
});

let server, base, out;

const run = async (sequence, extra = {}) => {
  const cassette = join(out, `cassette-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cassette, JSON.stringify({ sequence }));
  process.env.SCARECROW_LLM_CASSETTE = cassette;
  process.env.SCARECROW_LLM_MODE = "replay";
  const inputs = {
    url: `${base}/page-a.html`, personaKey: "test", task: "get to page B",
    persona: { name: "Tester", description: "You are a test persona." },
    steps: 3, glance: false, full: false, success: null, headed: false, device: "desktop",
    record: false, a11y: false, ci: false, quiet: true, json: false, yes: true, out,
    upload: [], logResponses: false, cfg: { provider: "anthropic", model: "test-model" },
    ...extra,
  };
  const result = await runSession(inputs, { version: "test", reporter: silent });
  return { inputs, result };
};

const findings = (extra = {}) => ({ input: {
  reaction: "Fine.", summary: "It worked", wouldCompleteTask: "yes",
  findings: [{ issue: "Link text is vague", severity: "low", heuristic: "Clarity", fix: "Say where it goes", steps: [1] }],
  ...extra,
} });

describe.skipIf(!hasChromium)("runSession (replayed model)", () => {
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "crow-session-"));
    server = createServer((req, res) => {
      const file = join(FIXTURES, new URL(req.url, "http://x").pathname.replace(/^\/+/, ""));
      if (!file.startsWith(FIXTURES) || !existsSync(file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(file));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
    delete process.env.SCARECROW_LLM_CASSETTE;
    delete process.env.SCARECROW_LLM_MODE;
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    rmSync(out, { recursive: true, force: true });
  });

  it("completes a flow, passes the success check, and writes clean + marked screenshots", async () => {
    const { inputs, result } = await run([
      { input: { thought: "The link to B is right there.", action: "click", target: 1 } },
      { input: { thought: "I'm on page B.", action: "done" } },
      findings(),
    ], { success: "text:Order confirmed" });

    expect(result.outcome).toBe("reached the goal");
    expect(result.assertion).toMatchObject({ kind: "text", passed: true });
    expect(result.toolFailures).toBe(0);
    expect(inputs.steps).toBe(3); // never mutated by the run

    const files = readdirSync(result.runDir);
    expect(files).toEqual(expect.arrayContaining(["findings.json", "report.md", "step-1.png", "step-1.marked.png", "step-2.png"]));
    const report = JSON.parse(readFileSync(join(result.runDir, "findings.json"), "utf8"));
    expect(report).toMatchObject({ stepsUsed: 2, toolFailures: 0, wouldCompleteTask: "yes" });
    const md = readFileSync(join(result.runDir, "report.md"), "utf8");
    expect(md).toMatch(/Objective check:\*\* PASS/);
    expect(md).toMatch(/Evidence: \[step 1\]\(step-1\.png\)/);
  }, 60_000);

  it("counts tool failures separately and records a failed success check", async () => {
    const { result } = await run([
      { input: { thought: "I'll click 99.", action: "click", target: 99 } },
      { input: { thought: "Forget it.", action: "giveup" } },
      findings({ wouldCompleteTask: "no", findings: [] }),
    ], { success: "url:/never-reached" });

    expect(result.outcome).toBe("gave up / bounced");
    expect(result.toolFailures).toBe(1);
    expect(result.assertion.passed).toBe(false);
    const md = readFileSync(join(result.runDir, "report.md"), "utf8");
    expect(md).toMatch(/Tool failures:\*\* 1/);
    expect(md).toMatch(/\[TOOL\] No element #99/);
  }, 60_000);
});
