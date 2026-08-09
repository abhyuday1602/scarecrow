// cli/resume.js — Session persistence and re-run capability
// Saves session state to allow resuming interrupted runs or re-running previous sessions

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { configDir } from "./paths.js";

// tmp+rename (same pattern as config.js/personas-store.js) so a crash or Ctrl+C mid-write
// can never leave session-state.json half-written / unparseable for the next `resume --list`.
function atomicWrite(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// Save session state for potential resume
export function saveSessionState(runDir, state) {
  const statePath = join(runDir, "session-state.json");
  const sessionData = {
    timestamp: new Date().toISOString(),
    inputs: state.inputs,
    history: state.history || [],
    steps: state.steps || [],
    currentStep: state.currentStep || 0,
    outcome: state.outcome || "incomplete",
    interrupted: true,
  };
  atomicWrite(statePath, JSON.stringify(sessionData, null, 2));
  return statePath;
}

// Load session state for resume
export function loadSessionState(runDir) {
  const statePath = join(runDir, "session-state.json");
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  } catch {
    return null;
  }
}

// All sessions in the runs directory, newest first — the one loader behind both
// `crow resume --list` and the TUI /resume picker. Completed runs are read from
// findings.json (what runSession writes); interrupted ones from session-state.json.
export function loadAllSessions(runsDir = join(configDir(), "runs"), limit = 20) {
  if (!existsSync(runsDir)) return [];

  const sessions = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runsDir, entry.name);
    const state = loadSessionState(runDir);

    let report = null;
    try {
      const reportPath = join(runDir, "findings.json");
      if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, "utf-8"));
    } catch { /* unreadable report — fall back to the state file alone */ }

    if (!state && !report) continue;

    sessions.push({
      id: entry.name,
      runDir,
      state,
      report,
      display: formatSessionDisplay(entry.name, state, report),
      status: state?.interrupted ? "interrupted" : report ? "completed" : "unknown",
      timestamp: state?.timestamp || report?.timestamp || null,
      persona: state?.inputs?.personaKey || report?.persona || "unknown",
      task: state?.inputs?.task || report?.goal || "unknown",
      url: state?.inputs?.url || report?.url || "unknown",
      findingCount: report?.findings?.length || 0,
      highCount: report?.findings?.filter((f) => f.severity === "high").length || 0,
    });
  }

  return sessions
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .slice(0, limit);
}

function formatSessionDisplay(id, state, report) {
  const persona = state?.inputs?.personaKey || report?.persona || "?";
  const task = state?.inputs?.task || report?.goal || "";
  const shortTask = task.length > 24 ? `${task.slice(0, 22)}..` : task;
  const status = state?.interrupted ? "⟳" : report ? "✓" : "?";
  return `${status} ${id}  ${persona}  ${shortTask || "no task"}`;
}

// Mark session as complete
export function markSessionComplete(runDir) {
  const statePath = join(runDir, "session-state.json");
  if (!existsSync(statePath)) return;

  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  state.interrupted = false;
  state.completedAt = new Date().toISOString();
  atomicWrite(statePath, JSON.stringify(state, null, 2));
}

// Single-quote a value for POSIX shells (the only safe general quoting form).
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// Generate re-run command from saved session
export function generateRerunCommand(state) {
  const i = state.inputs || {};
  const parts = ["crow", "run"];

  if (i.url) parts.push(shellQuote(i.url));
  if (i.personaKey) parts.push(`--persona ${i.personaKey}`);
  if (i.task) parts.push(`--task ${shellQuote(i.task)}`);
  if (i.steps && i.steps !== 8) parts.push(`--steps ${i.steps}`);
  if (i.provider) parts.push(`--provider ${i.provider}`);
  if (i.model) parts.push(`--model ${shellQuote(i.model)}`);
  if (i.headed) parts.push("--headed");
  if (i.device && i.device !== "desktop") parts.push(`--device ${i.device}`);
  // i.upload is the *resolved* list of absolute paths, and [] is truthy — so a plain
  // truthiness check appended "--upload" to every command, including runs that uploaded
  // nothing (which, bare, means "attach everything in uploads/"). Emit the explicit
  // basenames instead: that's the form uploads/README.md documents and resolveUploads takes.
  const uploads = Array.isArray(i.upload) ? i.upload : i.upload ? [i.upload] : [];
  if (uploads.length) parts.push(`--upload=${shellQuote(uploads.map((p) => basename(String(p))).join(","))}`);
  if (i.success) parts.push(`--success ${shellQuote(i.success)}`);
  if (i.record) parts.push("--record");
  if (i.a11y) parts.push("--a11y");
  if (i.ci) parts.push("--ci");
  if (i.json) parts.push("--json");
  if (i.quiet) parts.push("--quiet");
  if (i.full) parts.push("--full");

  return parts.join(" ");
}
