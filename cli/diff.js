// cli/diff.js — Compare multiple runs and show differences
// Useful for tracking improvements over time or comparing different personas

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./paths.js";
import { c, sym, panel } from "./ui.js";

// Load findings from a run directory
function loadFindings(runDir) {
  const findingsPath = join(runDir, "findings.json");
  if (!existsSync(findingsPath)) return null;
  try {
    return JSON.parse(readFileSync(findingsPath, "utf-8"));
  } catch {
    return null;
  }
}

// Compare two runs and generate diff
export function compareRuns(run1Path, run2Path) {
  const run1 = loadFindings(run1Path);
  const run2 = loadFindings(run2Path);

  if (!run1 || !run2) {
    return { error: "Could not load findings from one or both runs" };
  }

  const diff = {
    urls: { run1: run1.url, run2: run2.url, same: run1.url === run2.url },
    personas: { run1: run1.persona, run2: run2.persona, same: run1.persona === run2.persona },
    goals: { run1: run1.goal, run2: run2.goal, same: run1.goal === run2.goal },
    outcomes: { run1: run1.outcome, run2: run2.outcome, same: run1.outcome === run2.outcome },
    findings: {
      run1: run1.findings?.length || 0,
      run2: run2.findings?.length || 0,
      diff: (run2.findings?.length || 0) - (run1.findings?.length || 0),
    },
    severity: {
      run1: countSeverity(run1.findings),
      run2: countSeverity(run2.findings),
    },
    a11y: {
      run1: run1.a11y?.violations?.length || 0,
      run2: run2.a11y?.violations?.length || 0,
      diff: (run2.a11y?.violations?.length || 0) - (run1.a11y?.violations?.length || 0),
    },
    verdict: verdictFor(run1, run2),
    timestamp: {
      run1: run1.timestamp,
      run2: run2.timestamp,
    },
  };

  return diff;
}

// Count findings by severity
function countSeverity(findings) {
  const counts = { high: 0, medium: 0, low: 0 };
  if (!findings) return counts;
  for (const f of findings) {
    if (counts[f.severity] !== undefined) {
      counts[f.severity]++;
    }
  }
  return counts;
}

// "improved" / "regressed" / "unchanged", read straight off the deltas, most serious
// signal first: high findings decide outright; ties fall through to medium, then low,
// then the a11y violation count.
function verdictFor(run1, run2) {
  const s1 = countSeverity(run1.findings);
  const s2 = countSeverity(run2.findings);
  for (const tier of ["high", "medium", "low"]) {
    if (s2[tier] !== s1[tier]) return s2[tier] < s1[tier] ? "improved" : "regressed";
  }
  const a1 = run1.a11y?.violations?.length || 0;
  const a2 = run2.a11y?.violations?.length || 0;
  if (a2 !== a1) return a2 < a1 ? "improved" : "regressed";
  return "unchanged";
}

// Generate diff report as text
export function generateDiffReport(run1Path, run2Path) {
  const diff = compareRuns(run1Path, run2Path);
  if (diff.error) return diff.error;

  // More findings/violations = worse, so a positive delta is red.
  const delta = (n) => (n > 0 ? c.red(`+${n}`) : n < 0 ? c.green(String(n)) : c.dim("±0"));
  const pair = (label, p) =>
    `${c.dim(label.padEnd(9))}${p.run1 ?? "?"} ${c.dim("→")} ${p.run2 ?? "?"}${p.same ? "" : c.yellow("  (differs)")}`;
  const count = (label, a, b) => `${c.dim(label.padEnd(9))}${a} ${c.dim("→")} ${b}  ${delta(b - a)}`;

  const verdictLine =
    diff.verdict === "improved" ? c.green(`${sym.ok} improved`)
    : diff.verdict === "regressed" ? c.red(`${sym.err} regressed`)
    : c.dim("─ unchanged");

  return panel("run comparison", [
    pair("url", diff.urls),
    pair("persona", diff.personas),
    pair("goal", diff.goals),
    pair("outcome", diff.outcomes),
    "",
    count("findings", diff.findings.run1, diff.findings.run2),
    count("  high", diff.severity.run1.high, diff.severity.run2.high),
    count("  medium", diff.severity.run1.medium, diff.severity.run2.medium),
    count("  low", diff.severity.run1.low, diff.severity.run2.low),
    count("a11y", diff.a11y.run1, diff.a11y.run2),
    "",
    `${c.dim("verdict".padEnd(9))}${verdictLine}`,
  ]);
}

// Find all runs in a directory
export function findRuns(runsDir = join(configDir(), "runs")) {
  if (!existsSync(runsDir)) return [];

  const runs = [];
  const entries = readdirSync(runsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runsDir, entry.name);
    const findings = loadFindings(runDir);
    if (findings) {
      runs.push({
        dir: runDir,
        name: entry.name,
        url: findings.url,
        persona: findings.persona,
        goal: findings.goal,
        outcome: findings.outcome,
        findingsCount: findings.findings?.length || 0,
        timestamp: findings.timestamp,
      });
    }
  }

  return runs.sort((a, b) => b.name.localeCompare(a.name));
}
