// Browser layer. Wraps Playwright in a small Session class that the agent drives.
// Key trick: before each decision we draw numbered badges on every visible,
// clickable element ("set-of-marks"). The model then picks an element by NUMBER
// instead of guessing pixel coordinates — far more reliable.

import { chromium } from "playwright";

// Device viewport presets for mobile/tablet testing
export const DEVICE_PRESETS = {
  mobile:  { width: 390, height: 844, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
  tablet:  { width: 768, height: 1024, userAgent: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1" },
  desktop: { width: 1280, height: 800 },
  "desktop-lg": { width: 1440, height: 900 },
  "desktop-xl": { width: 1920, height: 1080 },
};

// Runs INSIDE the page. Must be self-contained (no outer-scope references).
// Clears old marks, finds visible interactive elements in the viewport, tags each
// with data-st-idx + a numbered badge, and returns [{idx, type, label}].
const ANNOTATE = () => {
  document.querySelectorAll("[data-st-mark]").forEach((e) => e.remove());
  document.querySelectorAll("[data-st-idx]").forEach((e) => {
    e.removeAttribute("data-st-idx");
    e.removeAttribute("data-st-label");
  });

  const sel =
    'a[href], button, input:not([type="hidden"]), textarea, select, ' +
    '[role="button"], [role="link"], [role="tab"], [role="checkbox"], ' +
    '[role="radio"], [role="menuitem"], [onclick], summary';
  const vw = window.innerWidth, vh = window.innerHeight;

  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  };

  const cands = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el)) continue;
    if (cands.some((c) => c.contains(el) || el.contains(c))) continue; // drop nested dupes
    cands.push(el);
    if (cands.length >= 40) break;
  }

  const out = [];
  cands.forEach((el, i) => {
    const idx = i + 1;
    if (el.tagName === "A" && el.target === "_blank") el.target = "_self"; // stay in one tab
    const type = (el.getAttribute("role") || el.tagName).toLowerCase();
    let label = (
      el.innerText ||
      el.value ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      ""
    ).trim().replace(/\s+/g, " ");
    if (!label && el.tagName === "INPUT") label = `${el.getAttribute("type") || "text"  } field`;
    label = label.slice(0, 60) || type;

    el.setAttribute("data-st-idx", String(idx));
    el.setAttribute("data-st-label", label.slice(0, 40));

    const r = el.getBoundingClientRect();
    const badge = document.createElement("div");
    badge.setAttribute("data-st-mark", "1");
    badge.textContent = String(idx);
    Object.assign(badge.style, {
      position: "fixed",
      left: `${Math.max(0, r.left)  }px`,
      top: `${Math.max(0, r.top)  }px`,
      zIndex: "2147483647",
      background: "#e11d48",
      color: "#fff",
      font: "700 12px/1 sans-serif",
      padding: "1px 4px",
      borderRadius: "3px",
      pointerEvents: "none",
      boxShadow: "0 0 0 1px #fff",
    });
    document.body.appendChild(badge);

    out.push({ idx, type, label });
  });
  return out;
};

// page.evaluate() has no built-in timeout (unlike click()/fill()) — a page whose JS
// thread never yields (an infinite loop, or deliberate anti-automation stalling) would
// otherwise hang the call, and with it the whole step loop, forever. Race it and fall
// back to a safe default instead.
async function withTimeout(promise, ms, fallback) {
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("evaluate timed out")), ms)),
    ]);
  } catch {
    return fallback;
  }
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
      const type = p.type === "navigate" ? "→" : "↻";
      return `${num}. ${type} ${p.url}`;
    }).join("\n");
  }

  async annotate() {
    return await withTimeout(this.page.evaluate(ANNOTATE), 10_000, []);
  }

  async shot() {
    const buf = await this.page.screenshot({ type: "png" });
    return buf.toString("base64");
  }

  async saveShot(path) {
    try { await this.page.screenshot({ path }); } catch { /* ignore */ }
  }

  // Current page URL (follows popups/navigation via the "page" handler in start()).
  url() {
    return this.page.url();
  }

  // Objective goal signal: is `needle` present in the page's visible text?
  async hasText(needle) {
    if (!needle) return false;
    return await withTimeout(
      this.page.evaluate(
        (t) => (document.body?.innerText || "").toLowerCase().includes(String(t).toLowerCase()),
        needle
      ),
      5_000,
      false
    );
  }

  async settle() {
    try { await this.page.waitForLoadState("load", { timeout: 15000 }); } catch { /* ignore */ }
    await this.page.waitForTimeout(1200);
  }

  // Execute one action; returns a short human-readable outcome string.
  async act(a) {
    const at = (n) => this.page.locator(`[data-st-idx="${n}"]`).first();
    const firstLine = (e) => String(e?.message || e).split("\n")[0];

    if (a.action === "click") {
      const loc = at(a.target);
      if ((await loc.count()) === 0) return `No element #${a.target} on the page.`;
      const label = (await loc.getAttribute("data-st-label")) || `#${a.target}`;
      // The in-flight window spans click + settle so a chooser the click opens
      // (often after a short page delay) is still treated as intentional.
      this._clickInFlight = true;
      try {
        try {
          await loc.click({ timeout: 8000 });
        } catch (e) {
          return `Couldn't click #${a.target} (${label}): ${firstLine(e)}`;
        }
        await this.settle();
      } finally {
        this._clickInFlight = false;
      }
      const newUrl = this.page.url();
      if (newUrl !== this.pageHistory[this.pageHistory.length - 1]?.url) {
        this._trackRoute(newUrl, "click");
      }
      return `Clicked #${a.target} (${label}).`;
    }

    if (a.action === "type") {
      const loc = at(a.target);
      if ((await loc.count()) === 0) return `No field #${a.target} on the page.`;
      try {
        await loc.fill(a.text ?? "");
      } catch (e) {
        return `Couldn't type into #${a.target}: ${firstLine(e)}`;
      }
      return `Typed "${a.text ?? ""}" into #${a.target}.`;
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

    return `(no-op: ${a.action})`;
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
