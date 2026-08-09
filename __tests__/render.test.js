import { describe, it, expect } from "vitest";
import { describe as describeAction, banner, buildReport, renderFindings, summary } from "../cli/render.js";
import { rule } from "../cli/ui.js";

describe("describe (action)", () => {
  it("describes click action", () => {
    expect(describeAction({ action: "click", target: 5 })).toBe("click #5");
  });

  it("describes type action", () => {
    expect(describeAction({ action: "type", target: 3, text: "hello" })).toBe('type "hello" → #3');
  });

  it("describes scroll action", () => {
    expect(describeAction({ action: "scroll" })).toBe("scroll down");
  });

  it("describes scrollup action", () => {
    expect(describeAction({ action: "scrollup" })).toBe("scroll up");
  });

  it("describes wait action", () => {
    expect(describeAction({ action: "wait" })).toBe("wait");
  });

  it("describes done action", () => {
    expect(describeAction({ action: "done" })).toBe("done — believes goal is achieved");
  });

  it("describes giveup action", () => {
    expect(describeAction({ action: "giveup" })).toBe("give up");
  });

  it("falls back to raw action for unknown", () => {
    expect(describeAction({ action: "unknown" })).toBe("unknown");
  });
});

describe("banner", () => {
  it("includes version number", () => {
    const result = banner("1.2.3");
    expect(result).toContain("1.2.3");
  });

  it("includes the brand name", () => {
    const result = banner("1.0.0");
    expect(result).toContain("Scarecrow");
  });
});

describe("buildReport", () => {
  const baseInputs = {
    persona: { name: "Test User" },
    personaKey: "test",
    task: "sign up",
    url: "https://example.com",
    cfg: { provider: "anthropic", model: "claude-3" },
  };

  it("includes persona and goal in output", () => {
    const result = buildReport({
      inputs: baseInputs,
      outcome: "reached the goal",
      finalUrl: "https://example.com/success",
      assertion: null,
      steps: [],
      reflection: "",
      findings: { summary: "test", wouldCompleteTask: "yes", findings: [] },
    });
    expect(result).toContain("Test User");
    expect(result).toContain("sign up");
    expect(result).toContain("https://example.com");
  });

  it("includes steps in output", () => {
    const steps = [
      { n: 1, shot: "step-01.png", thought: "Looking at the page", action: "click #1", result: "Clicked #1" },
    ];
    const result = buildReport({
      inputs: baseInputs,
      outcome: "reached the goal",
      finalUrl: "https://example.com",
      assertion: null,
      steps,
      reflection: "",
      findings: { summary: "test", wouldCompleteTask: "yes", findings: [] },
    });
    expect(result).toContain("Step 1");
    expect(result).toContain("click #1");
    expect(result).toContain("Clicked #1");
  });

  it("includes assertion when present", () => {
    const result = buildReport({
      inputs: baseInputs,
      outcome: "reached the goal",
      finalUrl: "https://example.com",
      assertion: { marker: "/success", passed: true },
      steps: [],
      reflection: "",
      findings: { summary: "test", wouldCompleteTask: "yes", findings: [] },
    });
    expect(result).toContain("PASS");
    expect(result).toContain("/success");
  });
});

describe("renderFindings", () => {
  it("renders findings to console", () => {
    const findings = {
      summary: "Good overall",
      wouldCompleteTask: "yes",
      findings: [
        { issue: "Confusing layout", severity: "medium", heuristic: "visibility", fix: "Move button up" },
      ],
    };
    // Should not throw
    expect(() => renderFindings(findings)).not.toThrow();
  });

  it("handles null findings", () => {
    expect(() => renderFindings(null)).not.toThrow();
  });
});

describe("summary", () => {
  it("returns a string panel", () => {
    const result = summary({
      findings: { wouldCompleteTask: "yes", findings: [{ severity: "high" }, { severity: "low" }] },
      outcome: "reached the goal",
      assertion: { marker: "/done", passed: true },
      files: ["./findings.json"],
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("YES");
    expect(result).toContain("1 high");
  });

  it("handles missing findings", () => {
    const result = summary({ findings: null, outcome: "ran out of steps" });
    expect(result).toContain("UNKNOWN");
  });
});

// Regression: rule()/panel() were hardcoded to 60 columns and nothing outside the Ink TUI
// read stdout.columns, so every rule and panel border wrapped onto a ragged second line on
// a narrow terminal. Shrink-only — the design width is unchanged on any normal window.
describe("layout width", () => {
  const withColumns = (cols, fn) => {
    const orig = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true });
    try { return fn(); } finally {
      if (orig) Object.defineProperty(process.stdout, "columns", orig);
      else delete process.stdout.columns;
    }
  };

  it("shrinks to fit a narrow terminal", () => {
    expect(withColumns(40, () => rule()).length).toBe(40);
  });

  it("stays at the 60-column design width on a normal terminal", () => {
    expect(withColumns(120, () => rule()).length).toBe(60);
    expect(withColumns(80, () => rule()).length).toBe(60);
  });

  it("keeps a floor so an absurdly narrow window still renders", () => {
    expect(withColumns(3, () => rule()).length).toBe(20);
  });

  it("falls back to the design width when the size is unknown", () => {
    expect(withColumns(undefined, () => rule()).length).toBe(60);
  });

  it("sizes the panel border to match", () => {
    const lines = withColumns(40, () => summary({ findings: null, outcome: "done" })).split("\n");
    // Last line is the bottom rule — the only unpadded, uncolored full-width border.
    expect(lines[lines.length - 1].length).toBe(40);
  });
});
