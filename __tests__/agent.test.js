import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamStringField, extractJson } from "../llm.js";
import { decideStep, debrief, glance } from "../agent.js";

describe("streamStringField", () => {
  const collect = (field = "thought") => {
    const out = [];
    return { out, feed: streamStringField(field, (t) => out.push(t)) };
  };

  it("streams only the named field's value", () => {
    const { out, feed } = collect();
    feed('{"thought":"Where is the sign-up button?","action":"scroll"}');
    expect(out.join("")).toBe("Where is the sign-up button?");
  });

  it("handles the field split across many fragments, including the key", () => {
    const { out, feed } = collect();
    for (const ch of '{"tho' + 'ught" : "Hmm, okay." , "action":"done"}') feed(ch);
    expect(out.join("")).toBe("Hmm, okay.");
  });

  it("decodes escapes, even when split across fragments", () => {
    const { out, feed } = collect();
    ['{"thought":"line one\\', 'nline \\"two\\" \\u00', 'e9"}'].forEach(feed);
    expect(out.join("")).toBe('line one\nline "two" é');
  });

  it("isn't fooled by braces or the field name inside other values", () => {
    const { out, feed } = collect("reaction");
    feed('{"summary":"a {weird} \\"reaction\\": thing","reaction":"It was fine."}');
    expect(out.join("")).toBe("It was fine.");
  });

  it("is a no-op without a sink", () => {
    expect(() => streamStringField("thought", undefined)("{}")).not.toThrow();
  });
});

describe("extractJson", () => {
  it("parses a plain object", () => {
    expect(extractJson('{"action":"click","target":3}')).toEqual({ action: "click", target: 3 });
  });

  it("ignores prose containing braces before the real object", () => {
    const text = 'I see a {confusing} banner. Then: {"action":"scroll"} trailing';
    expect(extractJson(text, ["action"])).toEqual({ action: "scroll" });
  });

  it("strips code fences", () => {
    expect(extractJson('```json\n{"summary":"ok"}\n```')).toEqual({ summary: "ok" });
  });

  it("returns null when there's no JSON", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson('{"broken": ')).toBeNull();
  });
});

// The agent functions against scripted model replies (llm.js cassette replay), so no
// network and no API key are involved.
describe("agent with a replayed model", () => {
  let dir;
  const persona = { name: "Test", description: "You are a test persona." };
  const cfg = { provider: "anthropic", model: "test-model" };
  const useSequence = (sequence) => {
    const path = join(dir, `cassette-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({ sequence }));
    process.env.SCARECROW_LLM_CASSETTE = path;
    process.env.SCARECROW_LLM_MODE = "replay";
  };

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "crow-agent-")); });
  afterEach(() => {
    delete process.env.SCARECROW_LLM_CASSETTE;
    delete process.env.SCARECROW_LLM_MODE;
    rmSync(dir, { recursive: true, force: true });
  });

  const step = (extra = {}) => decideStep({
    cfg, persona, goal: "sign up", stepNum: 1, maxSteps: 3, history: [],
    elements: [{ idx: 1, type: "button", label: "Sign up" }], screenshotB64: "AAAA", ...extra,
  });

  it("returns the structured action and streams the thought", async () => {
    useSequence([{ input: { thought: "There it is.", action: "click", target: 1 } }]);
    const chunks = [];
    const a = await step({ onChunk: (t) => chunks.push(t) });
    expect(a).toMatchObject({ action: "click", target: 1, thought: "There it is." });
    expect(chunks.join("")).toBe("There it is.");
  });

  it("re-asks once when the action isn't valid, then gives up cleanly", async () => {
    useSequence([{ input: { thought: "?", action: "teleport" } }, { input: null, text: "nonsense" }]);
    const a = await step();
    expect(a.action).toBe("giveup");
  });

  it("debrief returns findings with evidence steps", async () => {
    useSequence([{ input: {
      reaction: "Frustrating.", summary: "Hard to find", wouldCompleteTask: "no",
      findings: [{ issue: "CTA hidden", severity: "high", heuristic: "Visibility", fix: "Show it", steps: [2] }],
    } }]);
    const f = await debrief({ cfg, persona, goal: "sign up", transcript: "Step 1: …", outcome: "gave up" });
    expect(f.wouldCompleteTask).toBe("no");
    expect(f.findings[0].steps).toEqual([2]);
    expect(f).not.toHaveProperty("reaction");
  });

  it("debrief falls back gracefully when nothing parses", async () => {
    useSequence([{ input: null, text: "I refuse." }]);
    const f = await debrief({ cfg, persona, goal: "x", transcript: "", outcome: "ran out of steps" });
    expect(f).toMatchObject({ wouldCompleteTask: "unsure", findings: [], _raw: "I refuse." });
  });

  it("glance splits narration from findings", async () => {
    useSequence([{ input: { reaction: "Looks busy.", summary: "Cluttered", wouldCompleteTask: "unsure", findings: [] } }]);
    const g = await glance({ cfg, persona, goal: "find pricing", screenshotB64: "AAAA" });
    expect(g.narration).toBe("Looks busy.");
    expect(g.findings).toEqual({ summary: "Cluttered", wouldCompleteTask: "unsure", findings: [] });
  });

  it("replay throws on a miss instead of calling the network", async () => {
    useSequence([]);
    await expect(step()).rejects.toThrow(/cassette miss/);
  });
});
