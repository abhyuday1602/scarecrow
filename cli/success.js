// cli/success.js — the objective `--success` check: a ground-truth signal about the run's
// end state that decides pass/fail instead of the model's own impression.
//
// Spec syntax:
//   Order confirmed          no prefix: passes if the visible text has it as a whole word
//                            (case-insensitive) OR the URL contains it — the original
//                            behaviour, kept so existing --success values still work
//   text:Order confirmed     whole-word, case-insensitive match in the visible page text only
//   text:/order #\d+/i       regex against the visible page text
//   url:/checkout/done       substring of the current URL
//   url:/\/orders\/\d+$/     regex against the current URL
//   selector:.order-summary  a visible element matches this CSS selector
//
// Pure apart from the `page` probe it's handed, so it's unit-testable without a browser.

const KINDS = ["text", "url", "selector"];

function toRegex(s) {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(s);
  if (!m) return null;
  try { return new RegExp(m[1], m[2]); } catch { throw new Error(`invalid regex in --success: ${s}`); }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Parse a --success string into { kind, raw, test } (test is a RegExp or a string).
// Throws a plain Error on an unusable spec; callers wrap it as a UserError.
export function parseSuccess(spec) {
  const raw = String(spec ?? "").trim();
  if (!raw) throw new Error("--success needs a value, e.g. --success \"Order confirmed\"");
  const m = /^([a-z]+):(.*)$/s.exec(raw);
  const kind = m && KINDS.includes(m[1]) ? m[1] : "auto";
  const value = (m && KINDS.includes(m[1]) ? m[2] : raw).trim();
  if (!value) throw new Error(`--success ${kind}: needs a value after the colon`);

  if (kind === "selector") return { kind, raw, test: value };
  if (kind === "auto") return { kind, raw, test: wholeWord(value), url: value.toLowerCase() };
  const re = toRegex(value);
  if (re) return { kind, raw, test: re };
  if (kind === "url") return { kind, raw, test: value.toLowerCase() };
  return { kind, raw, test: wholeWord(value) };
}

// Whole-word, case-insensitive: "Welcome" doesn't match "Welcomebot"; the edges are only
// anchored where the marker itself starts/ends with a word character.
function wholeWord(value) {
  const pre = /^\w/.test(value) ? "(?<![\\w])" : "";
  const post = /\w$/.test(value) ? "(?![\\w])" : "";
  return new RegExp(`${pre}${escapeRe(value)}${post}`, "i");
}

// Does the page currently satisfy the spec? `page` provides { url, text(), hasSelector(css) }
// — text() and hasSelector() are only called when the spec needs them.
export async function checkSuccess(spec, page) {
  const s = typeof spec === "string" ? parseSuccess(spec) : spec;
  if (s.kind === "selector") return !!(await page.hasSelector(s.test));
  if (s.kind === "url") {
    const url = String(page.url || "");
    return s.test instanceof RegExp ? s.test.test(url) : url.toLowerCase().includes(s.test);
  }
  if (s.kind === "auto" && String(page.url || "").toLowerCase().includes(s.url)) return true;
  const text = String((await page.text()) || "");
  return s.test.test(text);
}

// The single pass/fail rule shared by --ci, JUnit and the HTML export. An objective
// --success check, when present, decides task completion; otherwise the model's
// wouldCompleteTask does. A high-severity finding fails the run either way. Glance has no
// task to complete, so only findings count there.
export function runPassed({ findings, assertion, glance = false }) {
  const list = findings?.findings || [];
  const noHigh = !list.some((f) => f?.severity === "high");
  if (glance) return noHigh;
  return taskCompleted({ findings, assertion }) && noHigh;
}

// The task-completion half of runPassed: the objective check if there is one, else the
// model's own verdict.
export function taskCompleted({ findings, assertion }) {
  return assertion ? !!assertion.passed : findings?.wouldCompleteTask === "yes";
}
