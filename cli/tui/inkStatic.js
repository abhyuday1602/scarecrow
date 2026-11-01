// cli/tui/inkStatic.js — drop Ink's record of everything printed through <Static>.
//
// Ink keeps every line it has ever written via <Static> in a private `fullStaticOutput`
// buffer and replays ALL of it (after a clearTerminal) whenever a frame is as tall as the
// terminal. There's no public API to empty it, so after /clear the "cleared" transcript
// would come back on the next such repaint, and the buffer grows for the life of the TUI.
// We reach the live Ink instance through Ink's own stdout → instance map and reset it.
// Guarded throughout: if a future Ink moves these internals, this degrades to a no-op.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

let instances = null;
try {
  const entry = createRequire(import.meta.url).resolve("ink");
  instances = (await import(pathToFileURL(join(dirname(entry), "instances.js")).href)).default;
} catch { /* Ink's layout changed — resetStaticOutput() becomes a no-op */ }

export function resetStaticOutput(stdout) {
  const ink = instances?.get?.(stdout);
  if (ink && typeof ink.fullStaticOutput === "string") ink.fullStaticOutput = "";
}
