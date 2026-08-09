// cli/cleanup.js — single owner of process-level SIGINT/SIGTERM/uncaughtException handling.
//
// Before this module, SIGINT/SIGTERM/exit handlers were registered independently in
// cli/ollama.js, cli/commands.js, and cli/session.js. Node runs same-event listeners in
// registration order, and any one of them could call process.exit() first — ollama.js's
// handler called process.exit(0) directly, so on a Ctrl+C during an Ollama-backed run it
// could win the race against session.js's own SIGINT handler, skipping session.close() and
// leaking the browser process. There was also no uncaughtException/unhandledRejection
// handler, so a synchronous crash mid-run skipped cleanup entirely.
//
// Callers register cleanup work here instead of touching `process.on` themselves. On a real
// SIGINT/SIGTERM or an uncaught error, every registered cleanup runs (best effort — one
// throwing doesn't stop the rest) before the process exits exactly once.

import { logger } from "./logger.js";

const asyncCleanups = new Set(); // run on SIGINT/SIGTERM/uncaughtException (awaited)
const syncCleanups = new Set();  // ALSO run from the "exit" event (which forbids async work)
let installed = false;
let exiting = false;

// Register a cleanup function. Pass { sync: true } if it must also run from the "exit"
// event (e.g. resetting terminal state on a plain, non-signaled exit) — that listener can't
// await, so `fn` must be synchronous and fast there. Returns an unregister function; callers
// that handle their own cleanup on the normal-completion path (e.g. a `finally` block) should
// call it once that path has run, so this registry doesn't redo the work.
export function registerCleanup(fn, { sync = false } = {}) {
  install();
  asyncCleanups.add(fn);
  if (sync) syncCleanups.add(fn);
  return () => { asyncCleanups.delete(fn); syncCleanups.delete(fn); };
}

// Reverse registration order: the most recently registered resource (usually the innermost
// one, e.g. a live browser session) is cleaned up first. Clears both sets before awaiting so
// the "exit" event fired by the process.exit() call below doesn't redo the sync-flagged ones.
async function runAsyncCleanups() {
  const fns = [...asyncCleanups].reverse();
  asyncCleanups.clear();
  syncCleanups.clear();
  for (const fn of fns) {
    try { await fn(); } catch { /* best effort — one bad cleanup shouldn't block the rest */ }
  }
}

function runSyncCleanupsOnly() {
  for (const fn of [...syncCleanups].reverse()) {
    try { fn(); } catch { /* best effort */ }
  }
}

function install() {
  if (installed) return;
  installed = true;

  const onSignal = (code) => {
    if (exiting) return; // a second signal mid-cleanup — don't re-enter
    exiting = true;
    // Say something. Ctrl+C used to stop the output dead mid-action with no explanation,
    // which reads like a crash — and closing the browser isn't instant, so the pause needs
    // a reason. stderr, so a --json run's stdout stays parseable.
    if (code === 130) process.stderr.write("\nInterrupted — closing the browser and saving what's done…\n");
    runAsyncCleanups().finally(() => process.exit(code));
  };
  process.once("SIGINT", () => onSignal(130));
  process.once("SIGTERM", () => onSignal(143));

  // Sync-only: Node does not allow async work (including an already-pending Promise) to
  // block the "exit" event, so this only reruns anything left in syncCleanups — which will
  // be empty after a SIGINT/SIGTERM/crash path already cleared it in runAsyncCleanups().
  process.on("exit", runSyncCleanupsOnly);

  const onFatal = (event, err) => {
    try { logger.log(event, { message: err?.message || String(err) }); } catch { /* logger unavailable this early/late */ }
    if (exiting) return;
    exiting = true;
    runAsyncCleanups().finally(() => process.exit(1));
  };
  process.on("uncaughtException", (err) => onFatal("UNCAUGHT_EXCEPTION", err));
  process.on("unhandledRejection", (reason) => onFatal("UNHANDLED_REJECTION", reason));
}
