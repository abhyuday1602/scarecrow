// cli/render.js — turning run data into terminal output and the Markdown report.
// header / renderFindings / describe / buildReport are moved verbatim from the old
// index.js (same output); summary() and banner() are new presentation helpers.

import { c, sym, rule, panel } from "./ui.js";
import { BRAND } from "./brand.js";

const sevColor = { high: c.red, medium: c.yellow, low: c.green };
// Called (not cached) at each use: rule() reads the terminal width, and a module-level
// const would freeze it at import time and ignore both narrow windows and resizes.

// One-line brand banner shown at the top of a run.
export function banner(version) {
  return `${c.bold(BRAND)} ${c.dim(`v${  version}`)} ${c.dim(sym.dot)} ${c.dim("synthetic user testing")}`;
}

export function header({ url, personaKey, persona, task, cfg }) {
  console.log(`\n${  rule()}`);
  console.log(`${c.bold(persona.name)}  ${c.dim(`(${  personaKey  })`)}`);
  console.log(`${c.dim("goal:    ")} ${task}`);
  console.log(`${c.dim("url:     ")} ${url}`);
  console.log(`${c.dim("provider:")} ${cfg.provider} ${c.dim("·")} ${cfg.model}`);
  console.log(rule());
}

export function renderFindings(findings) {
  console.log(`\n${  rule()}`);
  console.log(`${c.cyan(c.bold("FINDINGS"))  }\n`);
  if (!findings) {
    console.log(c.yellow("(couldn't parse structured findings)"));
    return;
  }
  const feas = { yes: c.green, unsure: c.yellow, no: c.red }[findings.wouldCompleteTask] || ((s) => s);
  console.log(`${c.dim("verdict:")} ${findings.summary || "(none)"}`);
  console.log(`${c.dim("finished the task?")} ${feas(String(findings.wouldCompleteTask).toUpperCase())}\n`);
  (findings.findings || []).forEach((f, i) => {
    const tag = (sevColor[f.severity] || ((s) => s))(`[${String(f.severity).toUpperCase()}]`);
    console.log(`${i + 1}. ${tag} ${c.bold(f.issue)}`);
    if (f.heuristic) console.log(`   ${c.dim("heuristic:")} ${f.heuristic}`);
    if (f.fix) console.log(`   ${c.dim("fix:")} ${f.fix}`);
    console.log();
  });
}

export const describe = (a) => {
  switch (a.action) {
    case "click": return `click #${a.target}`;
    case "type": return `type "${a.text ?? ""}" → #${a.target}`;
    case "scroll": return "scroll down";
    case "scrollup": return "scroll up";
    case "wait": return "wait";
    case "done": return "done — believes goal is achieved";
    case "giveup": return "give up";
    default: return a.action;
  }
};

// Compact end-of-run summary panel: verdict, severity tallies, objective check,
// and where artifacts landed. Purely additive — nothing else stops printing.
export function summary({ findings, outcome, assertion, files = [] }) {
  const lines = [];
  const verdict = String(findings?.wouldCompleteTask ?? "unknown").toLowerCase();
  const vColor = { yes: c.green, unsure: c.yellow, no: c.red }[verdict] || ((s) => s);
  lines.push(`${c.dim("task completed?")} ${vColor(verdict.toUpperCase())}   ${c.dim("outcome:")} ${outcome}`);

  const list = findings?.findings || [];
  const n = { high: 0, medium: 0, low: 0 };
  for (const f of list) if (f.severity in n) n[f.severity]++;
  lines.push(
    `${c.dim("findings:")} ${c.red(`${n.high  } high`)} ${c.dim(sym.dot)} ` +
    `${c.yellow(`${n.medium  } medium`)} ${c.dim(sym.dot)} ${c.green(`${n.low  } low`)}`
  );
  if (assertion)
    lines.push(`${c.dim("objective check:")} ${assertion.passed ? c.green("PASS") : c.red("FAIL")} ${c.dim(`(marker: "${assertion.marker}")`)}`);
  for (const f of files) lines.push(`${c.dim("saved:")} ${f}`);

  return panel("SUMMARY", lines);
}

// Detailed Markdown walkthrough of the session (moved verbatim from index.js).
export function buildReport({ inputs, outcome, finalUrl, assertion, steps, reflection, findings }) {
  const bq = (t) =>
    (String(t || "").trim() || "(none)").split("\n").map((l) => `> ${  l}`).join("\n");
  const L = [];

  L.push("# Scarecrow session report", "");
  L.push(`- **Persona:** ${inputs.persona.name} (\`${inputs.personaKey}\`)`);
  L.push(`- **Goal:** ${inputs.task}`);
  L.push(`- **URL:** ${inputs.url}`);
  L.push(`- **Provider:** ${inputs.cfg.provider} · ${inputs.cfg.model}`);
  L.push(`- **Outcome:** ${outcome}`);
  L.push(`- **Final URL:** ${finalUrl}`);
  if (assertion)
    L.push(`- **Objective check:** ${assertion.passed ? "PASS" : "FAIL"} — marker "${assertion.marker}" ${assertion.passed ? "found" : "not found"}`);
  L.push(`- **Generated:** ${new Date().toISOString()}`);
  L.push("", "---", "");

  L.push("## Walkthrough", "");
  if (!steps.length) L.push("_No steps were taken._", "");
  for (const s of steps) {
    L.push(`### Step ${s.n} — ${s.action}`, "");
    L.push(bq(s.thought), "");
    L.push(`- **Action:** ${s.action}`);
    if (s.result) L.push(`- **Result:** ${s.result}`);
    L.push(`- **Screenshot:** [${s.shot}](${s.shot})`, "");
  }

  L.push("---", "");
  L.push("## Debrief", "");
  if (reflection) L.push("### Reflection", "", reflection, "");
  L.push("### Verdict", "");
  L.push(`- **Task completed?** ${String(findings?.wouldCompleteTask ?? "unknown").toUpperCase()}`);
  L.push(`- **Summary:** ${findings?.summary || "(none)"}`, "");

  L.push("### Findings", "");
  const list = findings?.findings || [];
  if (!list.length) L.push("_No findings reported._", "");
  list.forEach((f, i) => {
    L.push(`${i + 1}. **[${String(f.severity).toUpperCase()}] ${f.issue}**`);
    if (f.heuristic) L.push(`   - Heuristic: ${f.heuristic}`);
    if (f.fix) L.push(`   - Fix: ${f.fix}`);
  });
  L.push("");

  return L.join("\n");
}
