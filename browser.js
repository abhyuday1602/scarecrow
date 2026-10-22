// Browser layer. Wraps Playwright in a small Session class that the agent drives.
// Key trick: before each decision we draw numbered badges on the visible, clickable
// elements ("set-of-marks"). The model then picks an element by NUMBER instead of
// guessing pixel coordinates — far more reliable. The badges only exist for the marked
// screenshot the model decides from; the report's screenshots are taken clean.

import dns from "node:dns/promises";
import net from "node:net";
import { chromium } from "playwright";
import { isLinkLocal } from "./cli/args.js";

// Device viewport presets for mobile/tablet testing
export const DEVICE_PRESETS = {
  mobile:  { width: 390, height: 844, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
  tablet:  { width: 768, height: 1024, userAgent: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
  desktop: { width: 1280, height: 800 },
  "desktop-lg": { width: 1440, height: 900 },
  "desktop-xl": { width: 1920, height: 1080 },
};

// Runs INSIDE the page. Must be self-contained (no outer-scope references).
//
// Finds the interactive elements a person could actually use right now, numbers the most
// prominent `maxMarks` of them, and draws a numbered badge over each. Returns
// { elements: [{idx, type, label}], omitted, frames }.
//   - Searches the document, open shadow roots, and same-origin iframes (badges are placed
//     in top-level coordinates; act() resolves numbers across frames).
//   - Skips elements covered by something else (a cookie banner, a modal backdrop), checked
//     with elementFromPoint at the centre and two inset points.
//   - When a clickable wrapper (a card with an onclick) contains a native control, the
//     inner control wins, so the button inside a card is still reachable.
//   - Ranks by prominence (size, main content vs nav/header/footer, button-ness, height on
//     screen) rather than DOM order, so a dense nav can't crowd out the main CTA.
//   - Labels use the accessible name: aria-labelledby, aria-label, <label>, then text.
//   - Cross-origin iframes can't be inspected; they're reported in `frames` instead.
const ANNOTATE = (maxMarks) => {
  const SEL =
    'a[href], button, input:not([type="hidden"]), textarea, select, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], ' +
    '[role="menuitem"], [role="option"], [role="switch"], [role="combobox"], [onclick]';
  const NATIVE = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
  const vw = window.innerWidth, vh = window.innerHeight;
  const clean = (s) => String(s || "").trim().replace(/\s+/g, " ");

  // Every searchable root: { root, doc, offX, offY, frameEl } — documents, shadow roots,
  // and same-origin iframe documents (offset by the iframe's position on screen).
  const roots = [];
  const frames = [];
  const walk = (root, doc, offX, offY, frameEl) => {
    roots.push({ root, doc, offX, offY, frameEl });
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot, doc, offX, offY, frameEl);
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        const r = el.getBoundingClientRect();
        const onScreen = r.width > 20 && r.height > 20 && r.bottom + offY > 0 && r.top + offY < vh;
        let inner;
        try { inner = el.contentDocument; } catch { inner = null; }
        if (inner && inner.documentElement) {
          walk(inner, inner, offX + r.left + el.clientLeft, offY + r.top + el.clientTop, el);
        } else if (onScreen) {
          let host = "";
          try { host = new URL(el.src, window.location.href).host; } catch { /* srcdoc or blank */ }
          frames.push(clean(el.title || host || "embedded frame"));
        }
      }
    }
  };
  walk(document, document, 0, 0, null);

  // Clear the previous step's marks everywhere.
  document.querySelectorAll("[data-st-mark]").forEach((e) => e.remove());
  for (const { root } of roots) {
    root.querySelectorAll("[data-st-idx]").forEach((e) => {
      e.removeAttribute("data-st-idx");
      e.removeAttribute("data-st-label");
    });
  }

  const visibleRect = (el, offX, offY) => {
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) return null;
    const g = { left: r.left + offX, top: r.top + offY, right: r.right + offX, bottom: r.bottom + offY, width: r.width, height: r.height };
    if (g.bottom <= 0 || g.right <= 0 || g.top >= vh || g.left >= vw) return null;
    return { local: r, global: g };
  };

  // Not covered: at least one sample point lands on the element itself (or inside it), in
  // its own root, and — for iframe content — the iframe isn't covered in the top document.
  const reachable = (el, root, local, global, frameEl) => {
    const pts = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5]];
    return pts.some(([fx, fy]) => {
      const x = local.left + local.width * fx, y = local.top + local.height * fy;
      const gx = global.left + global.width * fx, gy = global.top + global.height * fy;
      if (gx < 0 || gy < 0 || gx >= vw || gy >= vh) return false;
      const hit = root.elementFromPoint ? root.elementFromPoint(x, y) : null;
      if (!hit || !(hit === el || el.contains(hit))) return false;
      if (frameEl) {
        const top = document.elementFromPoint(gx, gy);
        if (!top || !(top === frameEl || frameEl.contains(top))) return false;
      }
      return true;
    });
  };

  const accName = (el, root) => {
    const byId = (id) => (root.getElementById ? root.getElementById(id) : null) || el.ownerDocument.getElementById(id);
    let n = "";
    const ids = el.getAttribute("aria-labelledby");
    if (ids) n = ids.split(/\s+/).map((id) => byId(id)?.innerText || "").join(" ");
    n = clean(n) || clean(el.getAttribute("aria-label"));
    if (!n && el.labels && el.labels.length) n = clean([...el.labels].map((l) => l.innerText).join(" "));
    const isTextField = (el.tagName === "INPUT" && !/^(button|submit|reset|image|checkbox|radio)$/i.test(el.type)) || el.tagName === "TEXTAREA";
    if (!n && !isTextField && el.tagName !== "SELECT") n = clean(el.innerText);
    if (!n && el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type)) n = clean(el.value);
    n = n || clean(el.getAttribute("placeholder")) || clean(el.getAttribute("alt")) ||
      clean(el.querySelector?.("img[alt]")?.getAttribute("alt")) || clean(el.getAttribute("title"));
    if (el.tagName === "SELECT") {
      const sel = el.options[el.selectedIndex];
      n = `${n || "dropdown"} (selected: "${clean(sel?.label || sel?.text)}", ${el.options.length} options)`;
    } else if (isTextField && el.value) {
      n = `${n || "text field"} (contains: "${clean(el.value).slice(0, 30)}")`;
    } else if (el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type)) {
      n = `${n || el.type} (${el.checked ? "checked" : "unchecked"})`;
    }
    if (!n && el.tagName === "INPUT") n = `${el.getAttribute("type") || "text"} field`;
    return n;
  };

  const typeOf = (el) => {
    const role = el.getAttribute("role");
    if (role) return role.toLowerCase();
    if (el.tagName === "INPUT") return `input[${(el.getAttribute("type") || "text").toLowerCase()}]`;
    return el.tagName.toLowerCase();
  };

  // 1. Visible, uncovered candidates from every root.
  let cands = [];
  for (const { root, offX, offY, frameEl } of roots) {
    for (const el of root.querySelectorAll(SEL)) {
      if (el.disabled) continue;
      const rect = visibleRect(el, offX, offY);
      if (!rect || !reachable(el, root, rect.local, rect.global, frameEl)) continue;
      cands.push({ el, root, rect: rect.global });
    }
  }

  // 2. Nested candidates: an inner native control beats its wrapper; otherwise the outer
  //    element wins (its inner pieces aren't separately meaningful).
  const drop = new Set();
  for (const o of cands) {
    for (const i of cands) {
      if (o === i || !o.el.contains(i.el)) continue;
      if (NATIVE.has(i.el.tagName)) drop.add(o);
      else drop.add(i);
    }
  }
  cands = cands.filter((c) => !drop.has(c));

  // 3. Rank by prominence and keep the top maxMarks.
  const score = ({ el, rect }) => {
    let sc = Math.min(3, Math.log10(Math.max(1, rect.width * rect.height)) / 1.5);
    if (el.closest("main, [role=main], article")) sc += 2;
    if (el.closest("nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]")) sc -= 1.5;
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button" || /^(submit|button)$/i.test(el.type || "")) sc += 1.5;
    if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") sc += 1;
    sc += 1 - Math.min(1, Math.max(0, rect.top / vh));
    return sc;
  };
  const ranked = cands.map((c) => ({ ...c, score: score(c) })).sort((a, b) => b.score - a.score);
  const kept = ranked.slice(0, maxMarks);
  const omitted = ranked.length - kept.length;
  // Number in reading order (top-to-bottom, left-to-right) so the badges are easy to scan.
  kept.sort((a, b) => (Math.abs(a.rect.top - b.rect.top) > 8 ? a.rect.top - b.rect.top : a.rect.left - b.rect.left));

  // 4. Tag and badge.
  const host = document.body || document.documentElement;
  const elements = kept.map(({ el, root, rect }, i) => {
    const idx = i + 1;
    if (el.tagName === "A" && el.target === "_blank") el.target = "_self"; // stay in one tab
    const type = typeOf(el);
    const label = (accName(el, root) || type).slice(0, 80);
    el.setAttribute("data-st-idx", String(idx));
    el.setAttribute("data-st-label", label.slice(0, 40));

    const badge = document.createElement("div");
    badge.setAttribute("data-st-mark", "1");
    badge.textContent = String(idx);
    Object.assign(badge.style, {
      position: "fixed",
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top)}px`,
      zIndex: "2147483647",
      background: "#e11d48",
      color: "#fff",
      font: "700 12px/1 sans-serif",
      padding: "1px 4px",
      borderRadius: "3px",
      pointerEvents: "none",
      boxShadow: "0 0 0 1px #fff",
    });
    host.appendChild(badge);
    return { idx, type, label };
  });
  return { elements, omitted, frames };
};

// Removes the badges (the data-st-idx tags stay, so act() can still resolve numbers).
const CLEAR_MARKS = () => document.querySelectorAll("[data-st-mark]").forEach((e) => e.remove());

// How many elements get a number per step. Above ~50 the list costs tokens and attention
// without helping the model; the rest are reported as an "omitted" count.
const MAX_MARKS = 50;
// Keys the agent may press — a closed list so a model can't send arbitrary shortcuts.
const PRESSABLE = new Set(["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Space"]);

// page.evaluate() has no built-in timeout (unlike click()/fill()) — a page whose JS
// thread never yields (an infinite loop, or deliberate anti-automation stalling) would
// otherwise hang the call, and with it the whole step loop, forever. Race it and fall
// back to a safe default instead. The timer is always cleared, so a fast call doesn't
// leave a pending timeout keeping the event loop alive.
async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("evaluate timed out")), ms); }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

// Blocks requests to link-local addresses (169.254.0.0/16 incl. the cloud metadata
// endpoint, fe80::/10) for EVERY request the page makes — redirects, links the agent
// clicks, and the page's own fetches — not just the starting URL that assertSafeTarget
// checks. Hostnames are resolved (and cached) so a DNS name pointing there is caught too.
function makeLinkLocalGuard() {
  const cache = new Map();
  const blocked = async (hostname) => {
    const host = hostname.replace(/^\[|\]$/g, "");
    if (isLinkLocal(host)) return true;
    if (net.isIP(host)) return false;
    if (!cache.has(host)) {
      cache.set(host, dns.lookup(host, { all: true })
        .then((addrs) => addrs.some((a) => isLinkLocal(a.address)))
        .catch(() => false)); // unresolvable: let the browser fail it normally
    }
    return cache.get(host);
  };
  return async (route) => {
    let url;
    try { url = new URL(route.request().url()); } catch { return route.continue(); }
    if (!/^https?:$/.test(url.protocol)) return route.continue();
    if (await blocked(url.hostname)) return route.abort("blockedbyclient");
    return route.continue();
  };
}

export class Session {
  constructor({ headed = false, uploadFiles = [], device = "desktop", record = false } = {}) {
    this.headed = headed;
    this.uploadFiles = uploadFiles; // absolute paths, validated by the caller
    this.uploadLog = [];            // readable notes, drained by index.js per step
    this.device = device;           // mobile | tablet | desktop
    this.record = record;           // save video recording of the session
    this.videoPath = null;          // path to recorded video (set after close)
    this.pageHistory = [];          // track visited URLs for route-aware flows
    this._clickInFlight = false;    // true only while act() is performing a click
  }

  async start() {
    const preset = DEVICE_PRESETS[this.device] || DEVICE_PRESETS.desktop;
    this.browser = await chromium.launch({
      headless: !this.headed,
      slowMo: this.headed ? 300 : 0, // when watching, slow actions enough to follow
    });
    const contextOptions = {
      viewport: { width: preset.width, height: preset.height },
    };
    if (preset.userAgent) {
      contextOptions.userAgent = preset.userAgent;
    }
    if (this.record) {
      contextOptions.recordVideo = {
        dir: this._recordDir || ".",
        size: { width: preset.width, height: preset.height },
      };
    }
    this.context = await this.browser.newContext(contextOptions);
    await this.context.route("**/*", makeLinkLocalGuard());
    // Intercept the native file picker on every page (Playwright fires "filechooser"
    // for both real <input type=file> and buttons that trigger a hidden one). The
    // WeakSet dedupes: context "page" fires for the initial newPage() too, so without it
    // the first page would get two listeners and attach every file twice.
    const wired = new WeakSet();
    const wire = (page) => {
      if (wired.has(page)) return;
      wired.add(page);
      page.on("filechooser", (ch) => this._handleFileChooser(ch));
    };
    this.context.on("page", (p) => { this.page = p; wire(p); }); // follow + wire popups
    this.page = await this.context.newPage();
    wire(this.page);
  }

  // Attach the configured files when an upload control opens its picker, bypassing the
  // OS dialog entirely. Records a human-readable note for the debrief/report.
  async _handleFileChooser(chooser) {
    // Only attach files while the agent's own click is in flight. A malicious page
    // can open a hidden file input at any time; attaching the user's uploads/ files
    // to it would let the page exfiltrate them.
    if (!this._clickInFlight) {
      this.uploadLog.push("A file chooser opened outside an agent action — cancelled it (nothing attached).");
      try { await chooser.setFiles([]); } catch { /* ignore */ }
      return;
    }
    if (!this.uploadFiles.length) {
      this.uploadLog.push("A file upload was requested, but no --upload file was provided, so nothing was attached.");
      // Cancel the chooser to unblock pages that wait for file input changes
      try { await chooser.setFiles([]); } catch { /* ignore */ }
      return;
    }
    const multiple = chooser.isMultiple();
    const files = multiple ? this.uploadFiles : this.uploadFiles.slice(0, 1);
    try {
      await chooser.setFiles(files);
      const names = files.map((f) => f.split(/[\\/]/).pop()).join(", ");
      const ignored = !multiple && this.uploadFiles.length > 1
        ? ` (this control accepts one file; ignored ${this.uploadFiles.length - 1} other(s))`
        : "";
      this.uploadLog.push(`Attached ${files.length} file(s): ${names}${ignored}.`);
    } catch (e) {
      this.uploadLog.push(`Upload failed: ${String(e?.message || e).split("\n")[0]}`);
    }
  }

  // Return and clear any upload notes recorded since the last call (null if none).
  drainUploads() {
    if (!this.uploadLog.length) return null;
    const note = this.uploadLog.join(" ");
    this.uploadLog = [];
    return note;
  }

  async open(url) {
    try {
      await this.page.goto(url, { waitUntil: "load", timeout: 45000 });
    } catch (e) {
      // A goto() timeout just means the page kept the network busy (websockets,
      // polling, a long-poll) without ever firing 'load' — it still rendered, so
      // proceed with whatever's on screen. Anything else (net::ERR_NAME_NOT_RESOLVED,
      // net::ERR_CONNECTION_REFUSED, a bad cert, …) means nothing ever painted —
      // stop the run instead of letting the agent report on Chrome's blank error page.
      if (e?.name !== "TimeoutError") {
        const reason = String(e?.message || e).split("\n")[0].replace(/^page\.goto:\s*/, "");
        throw new Error(`Couldn't reach ${url} — ${reason}`, { cause: e });
      }
    }
    await this.page.waitForTimeout(1500);
    this._trackRoute(url, "navigate");
  }

  // Track route changes for the report and the agent's context
  _trackRoute(url, type) {
    this.pageHistory.push({ url, type, timestamp: Date.now() });
  }

  // Get full route history
  getRouteHistory() {
    return [...this.pageHistory];
  }

  // Get current route context (last N pages)
  getRouteContext(maxPages = 5) {
    const recent = this.pageHistory.slice(-maxPages);
    if (recent.length === 0) return "No pages visited yet.";
    return recent.map((p, i) => {
      const num = i + 1;
      const type = p.type === "navigate" ? "→" : p.type === "back" ? "←" : "↻";
      return `${num}. ${type} ${p.url}`;
    }).join("\n");
  }

  // Number the interactive elements and draw their badges. Returns
  // { elements, omitted, frames } (see ANNOTATE). Call clearMarks() after taking the
  // marked screenshot so the badges never end up in anything else.
  async annotate() {
    const empty = { elements: [], omitted: 0, frames: [] };
    return await withTimeout(this.page.evaluate(ANNOTATE, MAX_MARKS), 10_000, empty);
  }

  async clearMarks() {
    await withTimeout(this.page.evaluate(CLEAR_MARKS), 5_000, null);
  }

  async shot() {
    const buf = await this.page.screenshot({ type: "png" });
    return buf.toString("base64");
  }

  // Current page URL (follows popups/navigation via the "page" handler in start()).
  url() {
    return this.page.url();
  }

  // Visible text of the page, for the objective success check (cli/success.js).
  async pageText() {
    return await withTimeout(this.page.evaluate(() => document.body?.innerText || ""), 5_000, "");
  }

  // Is an element matching `css` present and visible? (for `--success selector:…`)
  async hasSelector(css) {
    try { return await this.page.locator(css).first().isVisible({ timeout: 2_000 }); }
    catch { return false; }
  }

  async settle() {
    try { await this.page.waitForLoadState("load", { timeout: 15000 }); } catch { /* ignore */ }
    await this.page.waitForTimeout(1200);
  }

  // Resolve an element number to a locator, looking in every frame (numbers can land
  // inside same-origin iframes). Returns null if no frame has it.
  async _locate(n) {
    for (const frame of this.page.frames()) {
      const loc = frame.locator(`[data-st-idx="${n}"]`).first();
      try { if ((await loc.count()) > 0) return loc; } catch { /* frame detached */ }
    }
    return null;
  }

  _noteRoute(type) {
    const newUrl = this.page.url();
    if (newUrl !== this.pageHistory[this.pageHistory.length - 1]?.url) this._trackRoute(newUrl, type);
  }

  // Execute one action; returns a short human-readable outcome string. Failures caused by
  // the automation itself (element gone, timed out, wrong kind of element) start with
  // "[TOOL]" so the report and debrief can tell them apart from the site's own friction.
  async act(a) {
    const firstLine = (e) => String(e?.message || e).split("\n")[0];
    const tool = (msg) => `[TOOL] ${msg}`;
    const needsTarget = ["click", "type", "select", "hover"].includes(a.action);
    let loc = null, label = "";
    if (needsTarget) {
      loc = await this._locate(a.target);
      if (!loc) return tool(`No element #${a.target} on the page.`);
      label = (await loc.getAttribute("data-st-label").catch(() => null)) || `#${a.target}`;
    }

    if (a.action === "click") {
      // The in-flight window spans click + settle so a chooser the click opens
      // (often after a short page delay) is still treated as intentional.
      this._clickInFlight = true;
      try {
        try {
          await loc.click({ timeout: 8000 });
        } catch (e) {
          return tool(`Couldn't click #${a.target} (${label}): ${firstLine(e)}`);
        }
        await this.settle();
      } finally {
        this._clickInFlight = false;
      }
      this._noteRoute("click");
      return `Clicked #${a.target} (${label}).`;
    }

    if (a.action === "type") {
      const text = a.text ?? "";
      // Real keystrokes (not fill()) so key handlers, input masks and autocomplete fire
      // the way they would for a person. fill() is the fallback for fields that don't
      // take keyboard input directly.
      try {
        await loc.fill("", { timeout: 5000 });
        await loc.pressSequentially(text, { delay: 20, timeout: 15000 });
      } catch {
        try { await loc.fill(text, { timeout: 5000 }); }
        catch (e) { return tool(`Couldn't type into #${a.target} (${label}): ${firstLine(e)}`); }
      }
      return `Typed "${text}" into #${a.target} (${label}).`;
    }

    if (a.action === "select") {
      const want = String(a.option ?? a.text ?? "").trim();
      if (!want) return tool(`No option given to select in #${a.target}.`);
      let options;
      try {
        options = await loc.evaluate((el) => (el.tagName === "SELECT" ? [...el.options].map((o) => ({ label: (o.label || o.text).trim(), value: o.value })) : null));
      } catch (e) { return tool(`Couldn't read #${a.target}: ${firstLine(e)}`); }
      if (!options) return tool(`#${a.target} (${label}) isn't a dropdown — click it instead.`);
      const lc = want.toLowerCase();
      const match = options.find((o) => o.label.toLowerCase() === lc)
        || options.find((o) => o.value.toLowerCase() === lc)
        || options.find((o) => o.label.toLowerCase().includes(lc));
      if (!match) return `#${a.target} (${label}) has no option "${want}". Options: ${options.map((o) => o.label).slice(0, 12).join(", ")}.`;
      try { await loc.selectOption({ value: match.value }, { timeout: 5000 }); }
      catch (e) { return tool(`Couldn't select "${match.label}" in #${a.target}: ${firstLine(e)}`); }
      await this.settle();
      this._noteRoute("select");
      return `Selected "${match.label}" in #${a.target} (${label}).`;
    }

    if (a.action === "hover") {
      try { await loc.hover({ timeout: 5000 }); }
      catch (e) { return tool(`Couldn't hover over #${a.target} (${label}): ${firstLine(e)}`); }
      await this.page.waitForTimeout(700);
      return `Hovered over #${a.target} (${label}).`;
    }

    if (a.action === "press") {
      const key = String(a.key ?? a.text ?? "");
      if (!PRESSABLE.has(key)) return tool(`Can't press "${key}" — use one of ${[...PRESSABLE].join(", ")}.`);
      await this.page.keyboard.press(key === "Space" ? " " : key);
      await this.settle();
      this._noteRoute("press");
      return `Pressed ${key}.`;
    }

    if (a.action === "back") {
      const before = this.page.url();
      let resp = null;
      try { resp = await this.page.goBack({ waitUntil: "load", timeout: 15000 }); }
      catch { /* timed out: whatever rendered still counts */ }
      if (!resp && this.page.url() === before) return "There was no previous page to go back to.";
      await this.settle();
      this._noteRoute("back");
      return `Went back to ${this.page.url()}.`;
    }

    if (a.action === "scroll") {
      await this.page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.8)));
      await this.page.waitForTimeout(700);
      return "Scrolled down.";
    }

    if (a.action === "scrollup") {
      await this.page.evaluate(() => window.scrollBy(0, -Math.round(window.innerHeight * 0.8)));
      await this.page.waitForTimeout(700);
      return "Scrolled up.";
    }

    if (a.action === "wait") {
      await this.page.waitForTimeout(1500);
      return "Waited.";
    }

    return tool(`Unknown action "${a.action}".`);
  }

  // Set the directory where video recordings will be saved
  setRecordDir(dir) {
    this._recordDir = dir;
  }

  // Run axe-core accessibility audit on the current page
  async auditA11y() {
    try {
      // Inject axe-core source code
      const { default: axeCore } = await import("axe-core");
      await withTimeout(this.page.evaluate(axeCore.source), 10_000, null);

      // Run the audit
      const results = await withTimeout(
        this.page.evaluate(async () => {
          const axe = window.axe;
          if (!axe) return null;
          const results = await axe.run();
          return {
            violations: results.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              description: v.description,
              help: v.help,
              helpUrl: v.helpUrl,
              nodes: v.nodes.length,
              tags: v.tags,
            })),
            passes: results.passes.length,
            incomplete: results.incomplete.length,
          };
        }),
        15_000,
        null
      );

      return results;
    } catch {
      // axe-core may fail on some pages
      return null;
    }
  }

  async close() {
    // Get the video path before closing (Playwright saves it on close)
    if (this.record && this.context) {
      const pages = this.context.pages();
      if (pages.length > 0) {
        const video = pages[0].video();
        if (video) {
          try {
            this.videoPath = await video.path();
          } catch {
            // Video may not exist if no navigation happened
          }
        }
      }
    }
    // Close the context before the browser (releases its resources explicitly rather than
    // relying on browser.close() to cascade), and bound the whole shutdown by a timeout — a
    // wedged page (e.g. an open native dialog) can otherwise hang close() indefinitely and
    // block SIGINT cleanup.
    const shutdown = (async () => {
      try { await this.context?.close(); } catch { /* already closed / never opened */ }
      try { await this.browser?.close(); } catch { /* already closed / never opened */ }
    })();
    await Promise.race([shutdown, new Promise((r) => setTimeout(r, 10_000))]);
  }
}
