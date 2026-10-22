// Real-browser tests for browser.js: element labelling (ANNOTATE) and every action in
// Session.act(), against small fixture pages served over local HTTP. No LLM involved.
// Skipped, with a note, when Playwright's Chromium isn't installed.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Session } from "../browser.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const hasChromium = (() => { try { return existsSync(chromium.executablePath()); } catch { return false; } })();
if (!hasChromium) console.warn("browser.test.js skipped: run `npx playwright install chromium` to enable it");

let server, base, session;

const open = async (name) => {
  await session.open(`${base}/${name}`);
  return session.annotate();
};
const find = (elements, re) => elements.find((e) => re.test(e.label));
const text = (sel) => session.page.locator(sel).first().textContent();

describe.skipIf(!hasChromium)("browser Session", () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      const file = join(FIXTURES, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, ""));
      if (!file.startsWith(FIXTURES) || !existsSync(file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(file));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    session = new Session({ headed: false });
    await session.start();
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await new Promise((r) => server?.close(r));
  });

  describe("annotate", () => {
    it("skips elements covered by an overlay (cookie banner)", async () => {
      const { elements } = await open("cookie-banner.html");
      expect(find(elements, /Start free trial/)).toBeUndefined();
      expect(find(elements, /Accept all/)).toBeDefined();
      expect(find(elements, /Docs/)).toBeDefined();
    });

    it("prefers the button inside a clickable card over the card", async () => {
      const { elements } = await open("card-wrapper.html");
      expect(find(elements, /Buy Starter/)).toMatchObject({ type: "button" });
      expect(find(elements, /Everything you need/)).toBeUndefined();
    });

    it("keeps the main CTA when a dense nav exceeds the mark budget", async () => {
      const { elements, omitted } = await open("dense-nav.html");
      expect(elements.length).toBeLessThanOrEqual(50);
      expect(omitted).toBeGreaterThan(0);
      expect(find(elements, /Get started/)).toBeDefined();
    });

    it("uses accessible names and describes dropdowns", async () => {
      const { elements } = await open("select-form.html");
      expect(find(elements, /^Plan \(selected: "Free", 3 options\)/)).toMatchObject({ type: "select" });
      expect(find(elements, /^Email/)).toMatchObject({ type: "input[email]" });
      const search = await open("search-enter.html");
      expect(find(search.elements, /^Search docs$/)).toBeDefined();
    });

    it("finds buttons inside open shadow roots", async () => {
      const { elements } = await open("shadow-dom.html");
      expect(find(elements, /Join the waitlist/)).toBeDefined();
    });

    it("finds controls inside same-origin iframes", async () => {
      const { elements } = await open("iframe-form.html");
      expect(find(elements, /Pay now/)).toBeDefined();
      expect(find(elements, /Card name/)).toBeDefined();
    });

    it("draws badges only until clearMarks()", async () => {
      await open("select-form.html");
      expect(await session.page.locator("[data-st-mark]").count()).toBeGreaterThan(0);
      await session.clearMarks();
      expect(await session.page.locator("[data-st-mark]").count()).toBe(0);
      // Numbers still resolve after the badges are gone.
      expect(await session.page.locator("[data-st-idx]").count()).toBeGreaterThan(0);
    });
  });

  describe("act", () => {
    it("selects a dropdown option by its label, types, and submits", async () => {
      const { elements } = await open("select-form.html");
      const plan = find(elements, /^Plan/), email = find(elements, /^Email/), go = find(elements, /Continue/);
      expect(await session.act({ action: "select", target: plan.idx, option: "pro — $12/mo" })).toMatch(/^Selected "Pro/);
      expect(await session.act({ action: "type", target: email.idx, text: "a@b.co" })).toMatch(/^Typed/);
      await session.act({ action: "click", target: go.idx });
      expect(await text("#out")).toBe("Chose pro for a@b.co");
    }, 30_000);

    it("types with real key events and presses Enter", async () => {
      const { elements } = await open("search-enter.html");
      await session.act({ action: "type", target: find(elements, /Search docs/).idx, text: "pricing" });
      expect(Number(await text("#keys"))).toBe("pricing".length);
      expect(await session.act({ action: "press", key: "Enter" })).toBe("Pressed Enter.");
      expect(await text("#out")).toBe("Results for pricing");
    }, 30_000);

    it("hovers to open a menu, then clicks the revealed item", async () => {
      const first = await open("hover-menu.html");
      await session.act({ action: "hover", target: find(first.elements, /Products/).idx });
      const { elements } = await session.annotate();
      await session.act({ action: "click", target: find(elements, /Pricing/).idx });
      expect(await text("#out")).toBe("Pricing opened");
    }, 30_000);

    it("clicks inside shadow roots and iframes", async () => {
      let { elements } = await open("shadow-dom.html");
      await session.act({ action: "click", target: find(elements, /Join the waitlist/).idx });
      expect(await text("#out")).toBe("joined");
      ({ elements } = await open("iframe-form.html"));
      expect(await session.act({ action: "click", target: find(elements, /Pay now/).idx })).toMatch(/^Clicked/);
    }, 30_000);

    it("goes back to the previous page", async () => {
      const { elements } = await open("page-a.html");
      await session.act({ action: "click", target: find(elements, /page B/).idx });
      expect(session.url()).toMatch(/page-b\.html$/);
      expect(await session.act({ action: "back" })).toMatch(/^Went back to .*page-a\.html/);
      expect(session.getRouteHistory().at(-1).type).toBe("back");
    }, 30_000);

    it("tags automation failures with [TOOL]", async () => {
      await open("page-a.html");
      expect(await session.act({ action: "click", target: 999 })).toMatch(/^\[TOOL\] No element #999/);
      expect(await session.act({ action: "press", key: "F12" })).toMatch(/^\[TOOL\]/);
      const { elements } = await session.annotate();
      expect(await session.act({ action: "select", target: elements[0].idx, option: "x" })).toMatch(/^\[TOOL\] .* isn't a dropdown/);
    }, 30_000);
  });

  it("exposes page text and selector checks for --success", async () => {
    await open("page-b.html");
    expect(await session.pageText()).toMatch(/Order confirmed/);
    expect(await session.hasSelector(".order-summary")).toBe(true);
    expect(await session.hasSelector(".nope")).toBe(false);
  });
});
