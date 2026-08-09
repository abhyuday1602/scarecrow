#!/usr/bin/env node
// Scarecrow — synthetic user testing for your product.
//
// This file is just the entry point: parse args, set up color/env/context, route to a
// command, and translate thrown errors into clean exit codes. All the real work lives
// in cli/ (parsing, prompts, rendering) and the engine modules (agent/llm/browser).
//
//   crow                      guided interactive mode
//   crow <url> [options]      run a click-through session (the default)
//   crow <command> [options]  run | glance | personas | doctor | init | config
//   crow --help | --version

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv, presentKeys } from "./cli/env.js";
import { loadConfig } from "./cli/config.js";
import { parse, COMMANDS, looksLikeUrl, suggest } from "./cli/args.js";
import { c, setColor, isCancel, isInteractive, UserError } from "./cli/ui.js";
import { redact } from "./cli/logger.js";
import { BIN } from "./cli/brand.js";
import { isUnsupportedNode, unsupportedNodeMessage } from "./cli/node-check.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function readManifest() {
  try {
    return JSON.parse(readFileSync(join(SCRIPT_DIR, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

const readVersion = () => readManifest().version || "0.0.0";

async function main() {
  const parsed = parse(process.argv.slice(2));

  // Color: explicit --color/--no-color wins, then saved config, else the auto default
  // (which already honors NO_COLOR / non-TTY). Resolve it before any output.
  const config = loadConfig();
  if (parsed.flags.color === true) setColor(true);
  else if (parsed.flags.color === false) setColor(false);
  else if (typeof config.color === "boolean") setColor(config.color);

  if (parsed.errors.length) {
    for (const e of parsed.errors) console.error(c.red("error: ") + e);
    console.error(c.dim(`\nRun \`${BIN} --help\` for usage.`));
    process.exit(1);
  }

  // --version is global and short-circuits everything.
  if (parsed.flags.version) {
    console.log(`${BIN} ${  readVersion()}`);
    return;
  }

  // Help: either `--help` (on any command) or the `help [command]` command. Loaded
  // lazily so the help/version paths stay instant.
  if (parsed.flags.help || parsed.command === "help") {
    const target = parsed.flags.help ? parsed.command : parsed.positionals[0];
    const { globalHelp, commandHelp } = await import("./cli/help.js");
    console.log(target && COMMANDS[target] ? commandHelp(target) : globalHelp());
    return;
  }

  // Everything past this point actually does work, so this is where an unsupported
  // runtime has to stop. npm only *warns* on an engines mismatch, so we get here on old
  // Node and would otherwise fail several steps later with Playwright's own version
  // error — which names a dependency the user never installed. --version and --help are
  // deliberately above this line: they're dependency-free, and someone filing a bug
  // report should still be able to read their own version number.
  const supportedNode = readManifest().engines?.node;
  if (isUnsupportedNode(supportedNode)) {
    console.error(c.red(unsupportedNodeMessage(supportedNode)));
    process.exit(1);
  }

  // Everything below may need keys: load .env now (cwd wins, then the script's dir).
  const envFiles = loadEnv(SCRIPT_DIR);
  const ctx = { scriptDir: SCRIPT_DIR, config, version: readVersion(), envFiles, engines: readManifest().engines };
  const cmds = await import("./cli/commands.js");

  switch (parsed.command) {
    case "personas": return cmds.cmdPersonas(parsed);
    case "config":   return cmds.cmdConfig(parsed);
    case "export":   return cmds.cmdExport(parsed);
    case "resume":   return cmds.cmdResume(parsed, ctx);
    case "diff":     return cmds.cmdDiff(parsed);
    case "doctor":   return cmds.cmdDoctor(ctx);
    case "init":     return cmds.cmdInit(parsed, ctx);
    case "glance":   return cmds.cmdGlance(parsed, ctx);
    case "run":
      if (parsed.flags.batch) return cmds.cmdBatch(parsed, ctx);
      return cmds.cmdRun(parsed, ctx);
    default: {
      // Check for batch mode first (doesn't need a positional URL)
      if (parsed.flags.batch) return cmds.cmdBatch(parsed, ctx);

      // No command word. A bare token is treated as a URL (backward compatible);
      // if it's clearly not a URL but close to a command, flag the likely typo.
      const first = parsed.positionals[0];
      if (first) {
        if (!looksLikeUrl(first)) {
          const near = suggest(first, Object.keys(COMMANDS));
          if (near) throw new UserError(`Unknown command "${first}". Did you mean "${near}"?  (Run \`${BIN} --help\`.)`);
        }
        return cmds.cmdRun(parsed, ctx);
      }

      // Partial essential flags → guided step-by-step collection with confirmation
      const hasEssential = parsed.flags.url || parsed.flags.persona || parsed.flags.task;
      if (hasEssential && isInteractive()) {
        const { guidedCollect } = await import("./cli/guided.js");
        const cfg = await guidedCollect(parsed.flags.glance ? "glance" : "run", parsed, ctx);
        // Build a completed parsed object and run
        const completedParsed = {
          command: "run",
          positionals: [cfg.url],
          flags: {
            ...parsed.flags,
            url: cfg.url,
            persona: cfg.personaKey,
            task: cfg.task,
            steps: cfg.steps,
            glance: cfg.mode === "glance",
            device: cfg.device,
            record: cfg.record,
            a11y: cfg.a11y,
            headed: cfg.headed,
            provider: cfg.provider,
            model: cfg.model,
          },
        };
        return cmds.runFlow("run", completedParsed, ctx, { interactive: true, confirmRun: false });
      }

      // No args at all → the interactive TUI on a real terminal (lazy-loaded so the
      // one-shot/help/version paths never import React/Ink). Falls back to the guided
      // wizard's clear error when there's no TTY.
      if (isInteractive()) {
        // Check if the system is set up — if not, show the onboarding wizard first.
        const { isBrowserInstalled } = await import("./cli/browser-setup.js");
        const { isOllamaInstalled } = await import("./cli/ollama.js");
        const hasBrowser = await isBrowserInstalled();
        const hasProvider = presentKeys().length > 0 || await isOllamaInstalled();
        if (!hasBrowser || !hasProvider) {
          const { runOnboarding } = await import("./cli/onboarding.js");
          await runOnboarding(ctx);
        }
        const { startTui } = await import("./cli/tui/index.js");
        return startTui(ctx, parsed.flags);
      }
      return cmds.runWizard(parsed, ctx);
    }
  }
}

main().catch((e) => {
  if (isCancel(e)) {
    console.error(c.dim("\nCancelled."));
    process.exit(130);
  }
  const msg = redact(e?.message || String(e));
  if (e?.user) {
    console.error(c.red(msg));
    process.exit(1);
  }
  console.error(c.red("\nSomething failed: ") + msg);
  if (/Executable doesn't exist|browserType\.launch|playwright install/i.test(msg)) {
    console.error(c.dim(`Install the browser first:  npx playwright install chromium   (or run \`${BIN} doctor\`)`));
  } else if (/401|403|api key|unauthorized|permission/i.test(msg)) {
    console.error(c.dim(`Looks like an auth problem — check your key and model.  Run \`${BIN} doctor\`.`));
  } else if (/Couldn't reach/i.test(msg)) {
    console.error(c.dim("Check the URL and that the target is reachable from this machine."));
  }
  process.exit(1);
});
