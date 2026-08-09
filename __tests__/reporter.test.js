import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTerminalReporter } from "../cli/reporter.js";

// The reporter decides whether a mid-run question can be answered by looking at the
// tty-ness of the process. Fake both ends so the test doesn't depend on how vitest
// happens to be invoked.
const setTty = (on) => {
  process.stdin.isTTY = on;
  process.stdout.isTTY = on;
};

describe("onOutOfSteps", () => {
  let logs, origIn, origOut;

  beforeEach(() => {
    logs = [];
    origIn = process.stdin.isTTY;
    origOut = process.stdout.isTTY;
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
  });

  afterEach(() => {
    process.stdin.isTTY = origIn;
    process.stdout.isTTY = origOut;
    vi.restoreAllMocks();
  });

  // Regression: this used to call confirm() unconditionally, which throws without a
  // TTY. The throw aborted the whole session before the debrief ran, so an automated
  // run that hit its step limit wrote findings: [] and lost everything it had paid for.
  it("declines instead of prompting when stdout is not a tty", async () => {
    setTty(false);
    const rep = makeTerminalReporter({});
    await expect(rep.onOutOfSteps({ step: 3, totalSteps: 3 })).resolves.toBeNull();
  });

  it("declines instead of prompting under --yes, even on a tty", async () => {
    setTty(true);
    const rep = makeTerminalReporter({ yes: true });
    await expect(rep.onOutOfSteps({ step: 3, totalSteps: 3 })).resolves.toBeNull();
  });

  it("declines instead of prompting under --json, even on a tty", async () => {
    setTty(true);
    const rep = makeTerminalReporter({ json: true });
    await expect(rep.onOutOfSteps({ step: 3, totalSteps: 3 })).resolves.toBeNull();
  });

  it("explains why the run stopped, so the step limit isn't a silent truncation", async () => {
    setTty(false);
    const rep = makeTerminalReporter({});
    await rep.onOutOfSteps({ step: 3, totalSteps: 3 });
    expect(logs.join("\n")).toMatch(/step limit \(3\) reached/i);
  });

  it("stays quiet about it in --json mode, which owns stdout", async () => {
    setTty(false);
    const rep = makeTerminalReporter({ json: true });
    await rep.onOutOfSteps({ step: 3, totalSteps: 3 });
    expect(logs.join("\n")).toBe("");
  });
});

// The shape render.js's header() destructures — it reads persona.name and cfg directly.
const makeInputs = (personaKey) => ({
  url: "https://example.com",
  personaKey,
  persona: { name: `Test ${personaKey}` },
  task: "find the thing",
  cfg: { provider: "gemini", model: "gemini-2.5-flash" },
});

describe("step header url", () => {
  let logs;

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());

  // Regression: the header pinned the URL the run started on, so every step still
  // said example.com after the persona had navigated somewhere else.
  it("follows the persona as it navigates", () => {
    const rep = makeTerminalReporter({});
    rep.start({ inputs: makeInputs("skeptic") });
    rep.step(2, 3);
    rep.currentUrl("https://www.iana.org/");
    rep.action("click #1");
    expect(logs.join("\n")).toContain("https://www.iana.org/");
    expect(logs.join("\n")).not.toContain("https://example.com ·");
  });

  it("keeps the starting url when no navigation is reported", () => {
    const rep = makeTerminalReporter({});
    rep.start({ inputs: makeInputs("novice") });
    rep.step(1, 3);
    rep.action("scroll down");
    expect(logs.join("\n")).toContain("https://example.com");
  });
});

// Regression: --a11y wrote violations to findings.json but printed nothing at all, so an
// accessibility run showed a spinner and then appeared to have done nothing.
describe("a11y reporting", () => {
  let logs;

  const results = (n) => ({
    violations: Array.from({ length: n }, (_, i) => ({
      id: `rule-${i}`,
      impact: ["minor", "critical", "serious", "moderate"][i % 4],
      help: `Fix rule ${i}`,
      nodes: i + 1,
    })),
  });

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());

  it("prints the violation count", () => {
    makeTerminalReporter({}).a11y(results(4));
    expect(logs.join("\n")).toMatch(/a11y:.*4 violations/);
  });

  it("leads with the worst impact and caps the list", () => {
    makeTerminalReporter({}).a11y(results(8));
    const out = logs.join("\n");
    // 8 violations cycle the impacts, so two land in each bucket.
    expect(out).toMatch(/2 critical/);
    expect(out).toMatch(/\[critical\]/);
    // Only the top three are listed inline; the rest stay in findings.json.
    expect(out).toMatch(/and 5 more/);
    expect(out).not.toMatch(/\[minor\]/);
  });

  it("says so explicitly when the page is clean", () => {
    makeTerminalReporter({}).a11y({ violations: [] });
    expect(logs.join("\n")).toMatch(/no violations/);
  });

  it("stays silent in --json mode, which owns stdout", () => {
    makeTerminalReporter({ json: true }).a11y(results(3));
    expect(logs.join("\n")).toBe("");
  });

  it("prints nothing when the audit didn't run or failed", () => {
    const rep = makeTerminalReporter({});
    rep.a11y(null);
    rep.a11y({});
    expect(logs.join("\n")).toBe("");
  });
});
