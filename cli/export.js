// cli/export.js — Export findings in various formats for CI integration
// Supports: HTML (self-contained), JUnit XML, JSON (default)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Generate self-contained HTML report
export function generateHTML(findingsPath) {
  const data = JSON.parse(readFileSync(findingsPath, "utf-8"));
  const { url, persona, goal, outcome, finalUrl, findings = [], a11y, routeHistory } = data;

  const findingsHTML = findings.length
    ? findings.map((f) => `
      <tr class="finding severity-${severityClass(f.severity)}">
        <td>${escapeHTML((f.severity || "unknown").toUpperCase())}</td>
        <td>${escapeHTML(f.issue)}</td>
        <td>${escapeHTML(f.heuristic)}</td>
        <td>${escapeHTML(f.fix)}</td>
      </tr>`).join("")
    : '<tr><td colspan="4" class="no-findings">No usability findings</td></tr>';

  const a11yHTML = a11y?.violations?.length
    ? `<div class="a11y-section">
        <h2>Accessibility Violations (${a11y.violations.length})</h2>
        <table>
          <thead><tr><th>Rule</th><th>Impact</th><th>Description</th><th>Elements</th></tr></thead>
          <tbody>
            ${a11y.violations.map((v) => `
              <tr>
                <td>${escapeHTML(v.id)}</td>
                <td>${escapeHTML(v.impact)}</td>
                <td>${escapeHTML(v.description)}</td>
                <td>${Number(v.nodes) || 0}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`
    : "";

  const routeHTML = routeHistory?.length
    ? `<div class="route-section">
        <h2>Pages Visited</h2>
        <ol>${routeHistory.map((r) => `<li>${escapeHTML(r.url)} (${escapeHTML(r.type)})</li>`).join("")}</ol>
      </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scarecrow Report: ${escapeHTML(goal)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #1f2937; background: #fafaf9; max-width: 960px; margin: 0 auto; padding: 40px 24px; }
    header { border-bottom: 2px solid #1f2937; padding-bottom: 20px; margin-bottom: 28px; }
    h1 { font-size: 22px; letter-spacing: -0.01em; margin-bottom: 12px; }
    .meta { color: #6b7280; font-size: 14px; }
    .meta span { margin-right: 20px; }
    .outcome { display: inline-block; padding: 2px 10px; border-radius: 4px; font-weight: 600; font-size: 13px; margin-top: 12px; border: 1px solid; }
    .outcome.passed { color: #166534; border-color: #16a34a; background: #f0fdf4; }
    .outcome.failed { color: #991b1b; border-color: #dc2626; background: #fef2f2; }
    .outcome.unsure { color: #92400e; border-color: #d97706; background: #fffbeb; }
    section { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px; padding: 20px; margin-bottom: 20px; }
    h2 { color: #374151; margin-bottom: 14px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.04em; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    th { color: #6b7280; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    td:first-child { font-weight: 600; white-space: nowrap; }
    .severity-high td:first-child { color: #b91c1c; }
    .severity-medium td:first-child { color: #b45309; }
    .severity-low td:first-child { color: #15803d; }
    .severity-unknown td:first-child { color: #6b7280; }
    .no-findings { text-align: center; color: #9ca3af; }
    .a11y-section, .route-section { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px; padding: 20px; margin-bottom: 20px; }
    .route-section ol { padding-left: 24px; font-size: 14px; color: #374151; }
    .summary { font-size: 15px; color: #374151; }
    footer { text-align: center; color: #9ca3af; font-size: 12px; margin-top: 40px; }
  </style>
</head>
<body>
  <header>
    <h1>Scarecrow · Usability Report</h1>
    <div class="meta">
      <span><strong>URL:</strong> ${escapeHTML(url)}</span>
      <span><strong>Persona:</strong> ${escapeHTML(persona)}</span>
      <span><strong>Goal:</strong> ${escapeHTML(goal)}</span>
    </div>
    <div class="outcome ${outcome === "reached the goal" ? "passed" : outcome === "gave up / bounced" ? "failed" : "unsure"}">
      ${outcome === "reached the goal" ? "PASSED" : outcome === "gave up / bounced" ? "FAILED" : "INCONCLUSIVE"}
    </div>
  </header>

  <section>
    <h2>Summary</h2>
    <p class="summary">${escapeHTML(data.summary || "No summary available")}</p>
    <p style="margin-top: 10px;"><strong>Final URL:</strong> ${escapeHTML(finalUrl)}</p>
  </section>

  <section>
    <h2>Usability Findings (${findings.length})</h2>
    <table>
      <thead>
        <tr><th>Severity</th><th>Issue</th><th>Heuristic</th><th>Suggested Fix</th></tr>
      </thead>
      <tbody>${findingsHTML}</tbody>
    </table>
  </section>

  ${a11yHTML}
  ${routeHTML}

  <footer>
    Generated by Scarecrow · ${new Date().toISOString()}
  </footer>
</body>
</html>`;
}

// Generate JUnit XML for CI integration
export function generateJUnit(findingsPath) {
  const data = JSON.parse(readFileSync(findingsPath, "utf-8"));
  const { url, persona, goal, outcome, findings = [] } = data;

  // Failure bodies are escaped as XML text, not wrapped in CDATA — a finding
  // containing "]]>" would otherwise terminate the CDATA section early.
  const sessionFailure = outcome !== "reached the goal"
    ? `<failure message="Task not completed: ${escapeXML(outcome)}">${escapeXML([
        `Goal: ${goal}`,
        `Persona: ${persona}`,
        `Outcome: ${outcome}`,
        ...findings.map((f) => `[${(f.severity || "unknown").toUpperCase()}] ${f.issue}\n  Fix: ${f.fix}`),
      ].join("\n"))}</failure>`
    : "";

  const highFailures = findings
    .filter((f) => f.severity === "high")
    .map((f) => `<failure message="High severity finding: ${escapeXML(f.issue)}">${
      escapeXML(`${f.issue}\nHeuristic: ${f.heuristic}\nFix: ${f.fix}`)
    }</failure>`)
    .join("\n      ");

  const testcase = `
    <testcase name="${escapeXML(goal)}" classname="${escapeXML(url)}" time="0">
      ${sessionFailure}
      ${highFailures}
    </testcase>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Scarecrow Usability Tests" tests="1" failures="${(outcome !== "reached the goal" ? 1 : 0) + findings.filter((f) => f.severity === "high").length}" errors="0">
    ${testcase}
  </testsuite>
</testsuites>`;
}

// The formats `crow export --format` accepts. Exported so the CLI can validate (and name
// them in the error) without duplicating the list.
export const FORMATS = ["html", "junit", "xml", "json"];

// Save export in specified format
export function saveExport(findingsPath, format, outputDir) {
  let content, ext;

  switch (format) {
    case "html":
      content = generateHTML(findingsPath);
      ext = ".html";
      break;
    case "junit":
    case "xml":
      content = generateJUnit(findingsPath);
      ext = ".xml";
      break;
    case "json":
      content = readFileSync(findingsPath, "utf-8");
      ext = ".json";
      break;
    // `default:` used to fall in with "json", so an unsupported format (--format pdf)
    // silently wrote JSON and reported success.
    default:
      throw new Error(`unknown export format "${format}" — choose ${FORMATS.join(", ")}`);
  }

  const outPath = join(outputDir || ".", `export${ext}`);
  writeFileSync(outPath, content);
  return outPath;
}

// Severity is model output — whitelist it before it lands in a CSS class name.
function severityClass(s) {
  return ["high", "medium", "low"].includes(s) ? s : "unknown";
}

function escapeHTML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeXML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
