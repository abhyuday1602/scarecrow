import { describe, it, expect } from "vitest";
import { parseSuccess, checkSuccess, runPassed, taskCompleted } from "../cli/success.js";

const page = ({ url = "https://shop.example/", text = "", selectors = [] } = {}) => ({
  url,
  text: async () => text,
  hasSelector: async (css) => selectors.includes(css),
});

describe("parseSuccess", () => {
  it("treats a bare string as text-or-URL (the original behaviour)", () => {
    expect(parseSuccess("Welcome").kind).toBe("auto");
  });

  it("understands text:, url: and selector: prefixes", () => {
    expect(parseSuccess("url:/thanks").kind).toBe("url");
    expect(parseSuccess("selector:.order-summary")).toMatchObject({ kind: "selector", test: ".order-summary" });
    expect(parseSuccess("text:/order #\\d+/i").test).toBeInstanceOf(RegExp);
  });

  it("rejects empty specs and broken regexes", () => {
    expect(() => parseSuccess("")).toThrow();
    expect(() => parseSuccess("url:")).toThrow();
    expect(() => parseSuccess("text:/(/")).toThrow(/invalid regex/);
  });

  it("keeps an unknown prefix as part of the value", () => {
    expect(parseSuccess("note: done")).toMatchObject({ kind: "auto", raw: "note: done" });
  });
});

describe("checkSuccess", () => {
  it("a bare value passes on either the URL or the page text", async () => {
    expect(await checkSuccess("/projects/new", page({ url: "https://x.com/projects/new?id=1" }))).toBe(true);
    expect(await checkSuccess("Thanks", page({ text: "Thanks for signing up" }))).toBe(true);
    expect(await checkSuccess("Thanks", page({ text: "Thanksgiving sale" }))).toBe(false);
  });

  it("text: ignores the URL", async () => {
    expect(await checkSuccess("text:checkout", page({ url: "https://x.com/checkout", text: "Your cart" }))).toBe(false);
  });

  it("matches whole words only, case-insensitively", async () => {
    expect(await checkSuccess("welcome", page({ text: "Welcome back, Sam" }))).toBe(true);
    expect(await checkSuccess("Welcome", page({ text: "Try Welcomebot today" }))).toBe(false);
  });

  it("checks the URL by substring or regex", async () => {
    expect(await checkSuccess("url:/orders/", page({ url: "https://x.com/orders/12" }))).toBe(true);
    expect(await checkSuccess("url:/\\/orders\\/\\d+$/", page({ url: "https://x.com/orders/12" }))).toBe(true);
    expect(await checkSuccess("url:/\\/orders\\/\\d+$/", page({ url: "https://x.com/orders/new" }))).toBe(false);
  });

  it("matches page text by regex", async () => {
    expect(await checkSuccess("text:/order #\\d+/i", page({ text: "Your ORDER #1234 is confirmed" }))).toBe(true);
  });

  it("checks for a visible selector without reading the page text", async () => {
    const p = { url: "", text: async () => { throw new Error("not needed"); }, hasSelector: async (c) => c === ".done" };
    expect(await checkSuccess("selector:.done", p)).toBe(true);
    expect(await checkSuccess("selector:.nope", p)).toBe(false);
  });
});

describe("runPassed", () => {
  const f = (wouldCompleteTask, severities = []) => ({ wouldCompleteTask, findings: severities.map((severity) => ({ severity })) });

  it("uses the model's verdict when there's no objective check", () => {
    expect(runPassed({ findings: f("yes") })).toBe(true);
    expect(runPassed({ findings: f("unsure") })).toBe(false);
  });

  it("lets the objective check decide completion", () => {
    expect(runPassed({ findings: f("unsure"), assertion: { passed: true } })).toBe(true);
    expect(runPassed({ findings: f("yes"), assertion: { passed: false } })).toBe(false);
    expect(taskCompleted({ findings: f("no"), assertion: { passed: true } })).toBe(true);
  });

  it("fails on any high-severity finding, glance included", () => {
    expect(runPassed({ findings: f("yes", ["low", "high"]), assertion: { passed: true } })).toBe(false);
    expect(runPassed({ findings: f("no", ["medium"]), glance: true })).toBe(true);
    expect(runPassed({ findings: f("no", ["high"]), glance: true })).toBe(false);
  });
});
