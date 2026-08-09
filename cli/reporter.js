// cli/reporter.js — the run loop (cli/session.js) talks to a "reporter" instead of
// writing to stdout itself. The same orchestration then drives two front-ends:
//   • the plain CLI  → makeTerminalReporter (below), byte-for-byte the original output
//   • the Ink TUI    → cli/tui/inkReporter.js, which turns the same calls into React state
//
// Every method here is unconditional from the caller's point of view; the reporter
// decides whether to actually emit, based on the verbosity it was built with:
//   default   → stream the thinking, print everything           (pretty + loud)
//   --quiet   → no streamed thinking; still steps/findings       (pretty, not loud)
//   --json    → no decoration; only the JSON report on stdout    (neither)

import { stdout } from "node:process";
import { c, sym, spinner, noSpinner, streamPrinter, waitWithCountdown, confirm, text, isInteractive } from "./ui.js";
import { banner, header, renderFindings, summary } from "./render.js";

// A streamer that displays nothing (quiet/json) but keeps the {chunk,end} shape so the
// session loop can always pipe model tokens through it (and still capture them itself).
const noopStream = { chunk() {}, end() {} };

export function makeTerminalReporter({ quiet = false, json = false, yes = false } = {}) {
  const pretty = !json;
  const loud = !quiet && !json;
  // Whether a mid-run question can actually be answered. `--yes` and `--json` are
  // automation modes, and a piped stdin/stdout has nobody to type at the prompt —
  // in all three the run must finish on its own rather than throw.
  const canAsk = !yes && !json && isInteractive();
  const spin = json ? noSpinner : spinner;
  const log = pretty ? (...a) => console.log(...a) : () => {};
  // streamPrinter already shows a spinner until the first token; only when "loud".
  const stream = (label, indent = true) => {
    if (!loud) return noopStream;
    const p = streamPrinter(label, indent);
    return { chunk: p.onChunk, end: p.end };
  };

  return {
    // Banner + run header, shown once a run has loaded its first page.
    start({ version, inputs }) {
      if (!pretty) return;
      if (version) console.log(`\n${  banner(version)}`);
      this._url = inputs.url;
      this._personaKey = inputs.personaKey;
      header(inputs);
    },

    // A transient spinner for a wait (loading, reading the page, acting). Returns stop().
    phase(label) { return spin(label); },

    // Called on each rate-limit retry attempt. Handles the full wait duration including
    // live countdown. For quiet/json modes the countdown is suppressed and we just wait.
    async rateLimitWait({ waitMs, attempt, maxRetries }) {
      if (loud) {
        await waitWithCountdown(waitMs, `Rate limited (${attempt}/${maxRetries})`);
      } else {
        await new Promise((r) => setTimeout(r, waitMs));
      }
    },

    // --- session (click-through) ---
    step(n, total) { this._step = { n, total }; },
    thinking() { return stream("Thinking …"); },
    // The step header shows where the persona *is*, which changes as it navigates —
    // so prefer the live URL the session loop reports over the one the run started on.
    currentUrl(url) { if (url) this._url = url; },
    action(desc) {
      const ctx = this._url && this._personaKey ? ` ── ${this._url} · ${this._personaKey}` : "";
      // A long URL pushes this well past the terminal edge and wraps into a ragged second
      // line; the step number and action matter most, so the tail is what gets clipped.
      const line = `── Step ${this._step.n}/${this._step.total} ── ${desc}${ctx} ──`;
      const max = stdout.columns || 80;
      log(`\n${c.dim(line.length > max ? `${line.slice(0, Math.max(4, max - 1))}…` : line)}`);
    },
    result(text) { log(`  ${c.dim(`→ ${  text}`)}`); },
    sessionEnded(outcome, runDir) {
      log(`\n${c.dim(`session ended: ${  outcome}`)}`);
      // runDir is absolute (it lives under the XDG config dir), so no "./" prefix.
      log(c.dim(`screenshots saved to ${runDir}/`));
    },
    debriefHeading() { if (pretty) console.log(`\n${  c.cyan(c.bold("DEBRIEF"))  }\n`); },
    reflecting() { return stream("Reflecting …"); },

    // --- glance (one first impression) ---
    thinkingOutLoudHeading() {
      if (loud) console.log(`\n${  c.cyan(c.bold("THINKING OUT LOUD"))  }\n`);
    },
    looking() { return stream("Looking …", false); },

    // --- results, shared ---
    findings(obj) { if (pretty) renderFindings(obj); },
    rawFindings(text) {
      if (!pretty) return;
      console.log(c.yellow("\n(couldn't parse findings — raw below)\n"));
      console.log(text || "(none)");
    },
    objectiveCheck(assertion) {
      if (!pretty || !assertion) return;
      const mark = assertion.passed ? c.green("PASS") : c.red("FAIL");
      console.log(`${c.dim("objective check:")} ${mark} ${c.dim(`(marker: "${assertion.marker}")`)}`);
    },

    // The axe audit already lands in findings.json; without this the terminal showed only
    // a spinner, so `--a11y` looked like it had done nothing. Worst impact first, capped —
    // a real page can report dozens and they'd bury the findings section below.
    a11y(results) {
      if (!pretty) return;
      const violations = results?.violations;
      if (!violations) return;
      if (!violations.length) {
        console.log(`${c.dim("a11y:")} ${c.green("no violations")}`);
        return;
      }
      const rank = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      const tally = violations.reduce((acc, v) => {
        if (v.impact) acc[v.impact] = (acc[v.impact] || 0) + 1;
        return acc;
      }, {});
      const counts = Object.keys(rank)
        .filter((k) => tally[k])
        .map((k) => `${tally[k]} ${k}`)
        .join(` ${sym.dot} `);
      const total = `${violations.length} violation${violations.length === 1 ? "" : "s"}`;
      console.log(`${c.dim("a11y:")} ${c.yellow(total)}${counts ? ` ${c.dim(sym.dot)} ${c.dim(counts)}` : ""}`);

      const sorted = [...violations].sort((a, b) => (rank[a.impact] ?? 9) - (rank[b.impact] ?? 9));
      for (const v of sorted.slice(0, 3)) {
        const nodes = Number(v.nodes) || 0;
        console.log(
          `  ${c.dim(`[${v.impact || "unknown"}]`)} ${v.id}${v.help ? ` — ${v.help}` : ""}` +
          `${nodes ? c.dim(` (${nodes} element${nodes === 1 ? "" : "s"})`) : ""}`
        );
      }
      if (sorted.length > 3) console.log(c.dim(`  … and ${sorted.length - 3} more — see findings.json`));
    },
    artifacts(lines) { for (const l of lines) log(c.dim(l)); },
    summary(data) { if (pretty) console.log(`\n${  summary(data)}`); },

    // Called when the session runs out of steps — ask the user to extend. When nobody
    // can answer (--yes, --json, or a non-TTY), decline instead of asking: the run then
    // ends normally on "ran out of steps" and still gets a debrief. Throwing here used
    // to abort the whole session and discard every finding it had already paid for.
    onOutOfSteps: async ({ step, totalSteps }) => {
      if (!canAsk) {
        log(c.dim(`\n  Step limit (${totalSteps}) reached — wrapping up. Use -n to allow more steps.`));
        return null;
      }
      const ok = await confirm(`Step ${step}/${totalSteps}: ran out of steps. Add more?`, true);
      if (!ok) return null;
      const extra = await text("How many more steps?", { default: "5" });
      return { extraSteps: Math.max(1, parseInt(extra) || 5) };
    },

    // Machine-readable output (only in --json mode; ignored otherwise).
    json(obj) { if (json) console.log(JSON.stringify(obj, null, 2)); },
  };
}
