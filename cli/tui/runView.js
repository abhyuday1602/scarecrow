// cli/tui/runView.js — the Ink rendering of a run, driven by the model that
// cli/tui/inkReporter.js builds. <LiveRunView> is the in-progress run, clamped to a line
// budget so the live frame never outgrows the terminal; <RunView> is the full, frozen
// snapshot committed to the transcript when the run ends. The Ink analogue of cli/render.js.

import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { html } from "./html.js";
import { useTheme } from "./themeProvider.js";

// Semantic status colors, derived from the active theme so severity/verdict track the palette.
const sevColors = (t) => ({ high: t.error, medium: t.warning, low: t.success });
const verdictColors = (t) => ({ yes: t.success, unsure: t.warning, no: t.error });

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function Spinner({ label }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return html`<${Text} dimColor wrap="truncate-end">  ${FRAMES[i]} ${label}<//>`;
}

export function Banner() {
  const { theme } = useTheme();
  // ANSI-Shadow wordmark, "SCARECROW" — each row padded to a uniform 75 cols so
  // alignItems="center" (below) centers every row identically.
  const art = [
    "███████╗ ██████╗ █████╗ ██████╗ ███████╗██████╗ ██████╗ ██████╗ ██╗    ██╗",
    "██╔════╝██╔════╝██╔══██╗██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██║    ██║",
    "███████╗██║     ███████║██████╔╝█████╗  ██║     ██████╔╝██║  ██║██║ █╗ ██║",
    "╚════██║██║     ██╔══██║██╔══██╗██╔══╝  ██║     ██╔══██╗██║  ██║██║███╗██║",
    "███████║╚██████╗██║  ██║██║  ██║███████╗╚██████╗██║  ██║╚██████╔╝╚███╔███╔╝",
    "╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝ ╚═════╝  ╚══╝╚══╝ ",
  // rows are 74-75 cols raw; pad to a uniform width so alignItems="center" aligns them all.
  ].map((line) => line.padEnd(75));
  return html`
    <${Box} flexDirection="column" alignItems="center">
      ${art.map((line, i) => html`<${Text} key=${i} color=${theme.accent}>${line}<//>`)}
      <${Box} marginTop=${1}>
        <${Text} color=${theme.muted}>S Y N T H E T I C   U S E R   T E S T I N G<//>
      <//>
    <//>`;
}

export function Findings({ findings }) {
  const { theme } = useTheme();
  if (!findings) return html`<${Text} color=${theme.warning}>(couldn't parse structured findings)<//>`;
  const items = findings.findings || [];
  const sev = sevColors(theme);
  const vc = verdictColors(theme)[findings.wouldCompleteTask];
  return html`
    <${Box} flexDirection="column">
      <${Text} color=${theme.accent} bold>FINDINGS<//>
      <${Text}><${Text} dimColor>verdict: <//>${findings.summary || "(none)"}<//>
      <${Text}><${Text} dimColor>finished the task? <//><${Text} color=${vc}>${String(findings.wouldCompleteTask).toUpperCase()}<//><//>
      ${items.map((f, i) => html`
        <${Box} key=${i} flexDirection="column" marginTop=${1}>
          <${Text}>${i + 1}. <${Text} color=${sev[f.severity]}>[${String(f.severity).toUpperCase()}]<//> <${Text} bold>${f.issue}<//><//>
          ${f.heuristic ? html`<${Text}>   <${Text} dimColor>heuristic: <//>${f.heuristic}<//>` : null}
          ${f.fix ? html`<${Text}>   <${Text} dimColor>fix: <//>${f.fix}<//>` : null}
        <//>`)}
    <//>`;
}

export function Summary({ data }) {
  const { theme } = useTheme();
  const { findings, outcome, assertion, files = [] } = data || {};
  const verdict = String(findings?.wouldCompleteTask ?? "unknown").toLowerCase();
  const list = findings?.findings || [];
  const n = { high: 0, medium: 0, low: 0 };
  for (const f of list) if (f.severity in n) n[f.severity]++;
  const vc = verdictColors(theme);
  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor=${theme.accent} paddingX=${1}>
      <${Text}><${Text} dimColor>task completed? <//><${Text} color=${vc[verdict]}>${verdict.toUpperCase()}<//>   <${Text} dimColor>outcome: <//>${outcome}<//>
      <${Text}><${Text} dimColor>findings: <//><${Text} color=${theme.error}>${n.high} high<//> · <${Text} color=${theme.warning}>${n.medium} medium<//> · <${Text} color=${theme.success}>${n.low} low<//><//>
      ${assertion ? html`<${Text}><${Text} dimColor>objective check: <//><${Text} color=${assertion.passed ? theme.success : theme.error}>${assertion.passed ? "PASS" : "FAIL"}<//> <${Text} dimColor>(marker: "${assertion.marker}")<//><//>` : null}
      ${files.map((f, i) => html`<${Text} key=${i}><${Text} dimColor>saved: <//>${f}<//>`)}
    <//>`;
}

// Accessibility violations from the axe audit. Mirrors the plain-CLI renderer in
// cli/reporter.js: a tally line, then the worst few — the full list lives in findings.json.
const A11Y_RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };

export function A11y({ results, theme }) {
  const violations = results?.violations || [];
  if (!violations.length)
    return html`<${Text}><${Text} dimColor>a11y: <//><${Text} color=${theme.success}>no violations<//><//>`;

  const tally = {};
  for (const v of violations) if (v.impact) tally[v.impact] = (tally[v.impact] || 0) + 1;
  const counts = Object.keys(A11Y_RANK).filter((k) => tally[k]).map((k) => `${tally[k]} ${k}`).join(" · ");
  const sorted = [...violations].sort((a, b) => (A11Y_RANK[a.impact] ?? 9) - (A11Y_RANK[b.impact] ?? 9));

  return html`
    <${Box} flexDirection="column">
      <${Text}><${Text} dimColor>a11y: <//><${Text} color=${theme.warning}>${violations.length} violation${violations.length === 1 ? "" : "s"}<//>${counts ? html` <${Text} dimColor>· ${counts}<//>` : null}<//>
      ${sorted.slice(0, 3).map((v, i) => html`<${Text} key=${i}>  <${Text} dimColor>[${v.impact || "unknown"}]<//> ${v.id}${v.help ? ` — ${v.help}` : ""}<//>`)}
      ${sorted.length > 3 ? html`<${Text} dimColor>  … and ${sorted.length - 3} more — see findings.json<//>` : null}
    <//>`;
}

// Greedy word-wrap to `width` columns (all our run text is single-width); words longer
// than a line are hard-split. Always returns at least one line per paragraph.
function wrapText(text, width) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, width)); word = word.slice(width);
      }
      if (!word) continue;
      if (line && line.length + 1 + word.length > width) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

// --- LiveRunView: the in-progress run, as at most `maxLines` terminal rows ---
// Everything is flattened into single-row <Text wrap="truncate-end"> lines (streamed text
// is pre-wrapped to the width), so the row count is exact and we can keep just the tail.
// The live frame must stay shorter than the terminal: once it's as tall as the screen,
// Ink falls back to clearing the terminal and reprinting the whole <Static> transcript on
// every render — i.e. every spinner tick. Earlier steps collapse to one-line summaries;
// the complete run is committed to the transcript as a <RunView> when it ends.
export function LiveRunView({ model, cols, maxLines }) {
  const { theme } = useTheme();
  const width = Math.max(10, cols - 2); // inside the viewport's paddingX=1
  const lines = [];
  const line = (content, props = {}) =>
    lines.push(html`<${Text} key=${lines.length} wrap="truncate-end" ...${props}>${content}<//>`);
  const para = (text, indent, props) => {
    for (const l of wrapText(text, width - indent.length)) line(indent + l, props);
  };

  const h = model.header;
  if (h) {
    line([
      html`<${Text} key="name" bold>${h.personaName}<//>`,
      html`<${Text} key="ctx" dimColor>  ${h.url} · ${h.provider} · ${h.model}<//>`,
    ]);
  }
  model.steps.forEach((s, i) => {
    const current = i === model.steps.length - 1;
    line(`── Step ${s.n}/${s.total}${s.action ? ` ── ${s.action}` : ""} ──`, { dimColor: true });
    if (current && s.thought) para(s.thought, "  ", { dimColor: true });
    if (s.result) {
      if (current) para(`→ ${s.result}`, "  ", { dimColor: true });
      else line(`  → ${s.result.replace(/\s+/g, " ")}`, { dimColor: true });
    }
  });
  if (model.narrationActive) {
    line("THINKING OUT LOUD", { color: theme.accent, bold: true });
    if (model.narration) para(model.narration, "", { dimColor: true });
  }
  if (model.outcome) line(`session ended: ${model.outcome}`, { dimColor: true });
  if (model.debrief) {
    line("DEBRIEF", { color: theme.accent, bold: true });
    if (model.debrief.text) para(model.debrief.text, "", { dimColor: true });
  }
  if (model.findings) {
    const n = model.findings.findings?.length ?? 0;
    line(`findings ready — ${n} issue${n === 1 ? "" : "s"}`, { color: theme.accent });
  } else if (model.rawFindings) {
    line("(couldn't parse findings — raw output in the report)", { color: theme.warning });
  }
  if (model.phase) lines.push(html`<${Spinner} key="spinner" label=${model.phase} />`);

  const budget = Math.max(2, maxLines);
  const hidden = lines.length - budget;
  const shown = hidden > 0
    ? [html`<${Text} key="more" dimColor wrap="truncate-end">  ↑ ${hidden + 1} earlier lines · the full run prints when it ends<//>`,
       ...lines.slice(hidden + 1)]
    : lines;
  return html`<${Box} flexDirection="column">${shown}<//>`;
}

// --- RunView: the frozen, complete snapshot of a finished run (committed to scrollback) ---

export function RunView({ model, cols = 60 }) {
  const { theme } = useTheme();
  const h = model.header;
  // Match the header/footer bars' full-width feel instead of a fixed 60-char rule that
  // reads as a narrow strip floating on a wide terminal.
  const HR = "─".repeat(Math.max(1, cols - 2));
  return html`
    <${Box} flexDirection="column" marginTop=${1}>
      ${h ? html`
        <${Box} flexDirection="column">
          <${Text} dimColor>${HR}<//>
          <${Text} bold>${h.personaName}  <${Text} dimColor>(${h.personaKey})<//><//>
          <${Text}><${Text} dimColor>goal:    <//>${h.task}<//>
          <${Text}><${Text} dimColor>url:     <//>${h.url}<//>
          <${Text}><${Text} dimColor>provider: <//>${h.provider} · ${h.model}<//>
          <${Text} dimColor>${HR}<//>
        <//>` : null}

      ${model.steps.map((s) => html`
        <${Box} key=${s.n} flexDirection="column" marginTop=${1}>
          <${Text} dimColor>── Step ${s.n}/${s.total}${s.action ? ` ── ${s.action}` : ""}${model.header ? ` ── ${model.header.url} · ${model.header.personaKey}` : ""} ──<//>
          ${s.thought ? html`<${Text} dimColor>  ${s.thought}<//>` : null}
          ${s.result ? html`<${Text} dimColor>  → ${s.result}<//>` : null}
        <//>`)}

      ${model.narrationActive ? html`
        <${Box} flexDirection="column" marginTop=${1}>
          <${Text} color=${theme.accent} bold>THINKING OUT LOUD<//>
          ${model.narration ? html`<${Text} dimColor>${model.narration}<//>` : null}
        <//>` : null}

      ${model.outcome ? html`<${Box} marginTop=${1}><${Text} dimColor>session ended: ${model.outcome}<//><//>` : null}

      ${model.debrief ? html`
        <${Box} flexDirection="column" marginTop=${1}>
          <${Text} color=${theme.accent} bold>DEBRIEF<//>
          ${model.debrief.text ? html`<${Text} dimColor>${model.debrief.text}<//>` : null}
        <//>` : null}

      ${model.findings ? html`<${Box} marginTop=${1}><${Findings} findings=${model.findings} /><//>`
        : model.rawFindings ? html`
          <${Box} flexDirection="column" marginTop=${1}>
            <${Text} color=${theme.warning}>(couldn't parse findings — raw below)<//>
            <${Text}>${model.rawFindings}<//>
          <//>` : null}

      ${model.objective ? html`<${Text}><${Text} dimColor>objective check: <//><${Text} color=${model.objective.passed ? theme.success : theme.error}>${model.objective.passed ? "PASS" : "FAIL"}<//> <${Text} dimColor>(marker: "${model.objective.marker}")<//><//>` : null}

      ${model.a11y ? html`<${A11y} results=${model.a11y} theme=${theme} />` : null}

      ${model.artifacts?.length ? html`<${Box} flexDirection="column">${model.artifacts.map((l, i) => html`<${Text} key=${i} dimColor>${l}<//>`)}<//>` : null}

      ${model.summary ? html`<${Box} marginTop=${1}><${Summary} data=${model.summary} /><//>` : null}

      ${model.cancelled ? html`<${Text} color=${theme.warning}>run cancelled<//>` : null}
      ${model.error ? html`<${Text} color=${theme.error}>✗ ${model.error}<//>` : null}
    <//>`;
}
