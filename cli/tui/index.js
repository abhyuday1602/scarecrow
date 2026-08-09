// cli/tui/index.js — startTui(): the entry into the interactive Ink UI. The root index.js
// lazy-imports this only when run with no args on a real terminal, so the one-shot CLI,
// --help and --version paths never pay the cost of loading React/Ink.

import { isInteractive, UserError, c } from "../ui.js";
import { detectProvider } from "../env.js";
import { html } from "./html.js";
import { pick } from "../config.js";
import { resolveThemeName } from "./themes.js";
import { registerCleanup } from "../cleanup.js";

export async function startTui(ctx, flags = {}) {
  if (!isInteractive())
    throw new UserError('Interactive mode needs a terminal. Try `crow <url> -p <persona> -t "goal"`, or `crow --help`.');

  const cfg = ctx.config || {};

  // Warn if browser isn't installed — don't block the TUI (user can /doctor or install later).
  const { isBrowserInstalled } = await import("../browser-setup.js");
  if (!(await isBrowserInstalled())) {
    console.error(c.yellow("\n⚠ Chromium is not installed yet. You can install it later, or run `crow doctor` for help.\n"));
  }

  const theme = resolveThemeName(pick(flags.theme, cfg.theme, undefined));
  const initialSession = {
    url: undefined,
    task: undefined,
    personaKey: cfg.persona || undefined,
    mode: "walkthrough",
    steps: Number.isInteger(cfg.steps) ? cfg.steps : 8,
    provider: cfg.provider || detectProvider() || "anthropic",
    model: cfg.model || undefined,
    headed: typeof cfg.headed === "boolean" ? cfg.headed : true,
    full: !!cfg.full,
    success: null,
    upload: null,
    record: false,
    a11y: false,
    device: cfg.device || "desktop",
  };

  const { render } = await import("ink");
  const { App } = await import("./app.js");
  const { ThemeProvider } = await import("./themeProvider.js");
  const { resetTerminalBg } = await import("./terminalBg.js");

  // Whatever ends the process — clean exit, crash, or signal — give the user their terminal
  // background back. TTY writes are synchronous on POSIX, so this is safe in an exit handler.
  // SIGINT/SIGTERM are owned centrally by cli/cleanup.js (it calls process.exit(130/143)
  // after running every registered cleanup, this one included, then "exit" fires and this
  // also runs from the sync-cleanup pass — harmless, resetTerminalBg is idempotent).
  // SIGHUP has no other listener in the app, so it's handled locally: Node won't take its
  // default action once *any* listener is attached, so this must call process.exit() itself
  // to unblock (Ink can otherwise keep the process alive via raw-mode stdin).
  registerCleanup(resetTerminalBg, { sync: true });
  process.once("SIGHUP", () => process.exit(129));

  // Clear the screen once so the fixed-height frame starts at the top; Ink then owns and
  // redraws that block in place.
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  const instance = render(html`<${ThemeProvider} initialTheme=${theme}><${App} ctx=${ctx} initialSession=${initialSession} /><//>`, {
    exitOnCtrlC: false, // we handle Ctrl+C ourselves (stop a run, then confirm-to-exit)
    patchConsole: false,
  });
  await instance.waitUntilExit();
}
