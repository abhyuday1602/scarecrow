// cli/guided.js — Step-by-step guided input collection with full-viewport
// confirmation panel. Reuses collectInputs() for non-essential defaults, then
// shows a navigable confirmation screen before launching.
//
// Flow: collect missing essential fields → show confirmation → run or edit.
// Uses ANSI clear-screen and raw-mode arrow navigation (same approach as select()
// in ui.js but with a custom multi-line panel).

import { stdin, stdout } from "node:process";
import readline from "node:readline";
import {
  c, sym, isInteractive, UserError, text, select, confirm,
} from "./ui.js";
import { allPersonas } from "./personas-store.js";
import { hasKey, isLocalProvider } from "./env.js";
import { providerInfo } from "../llm.js";
import { BRAND } from "./brand.js";
import { normalizeUrl } from "./args.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function clearScreen() { stdout.write("\x1b[2J\x1b[H"); }

// ─── field definitions ──────────────────────────────────────────────────────

// Essential fields that must be collected before a run.
const ESSENTIAL_FIELDS = [
  { key: "url",        label: "URL",    required: true  },
  { key: "personaKey", label: "Persona", required: true  },
  { key: "task",       label: "Goal",    required: true  },
];

// Non-essential defaults (shown in confirmation, editable but not prompted).
const EXTRA_FIELDS = [
  { key: "steps",    label: "Steps",    default: 8,    coerce: (v) => Math.max(1, Number(v) || 8) },
  { key: "mode",     label: "Mode",     default: "run", coerce: (v) => ["run", "glance"].includes(v) ? v : "run" },
  { key: "device",   label: "Device",   default: "desktop", coerce: (v) => ["mobile", "tablet", "desktop", "desktop-lg", "desktop-xl"].includes(v) ? v : "desktop" },
  { key: "record",   label: "Record",   default: false, coerce: (v) => v === "on" || v === true },
  { key: "a11y",     label: "A11y",     default: false, coerce: (v) => v === "on" || v === true },
  { key: "headed",   label: "Browser",  default: true,  coerce: (v) => v !== "headless" },
];

// ─── confirmation panel ─────────────────────────────────────────────────────

// Renders the confirmation panel with the cursor on entry `activeIdx`.
function renderConfirmPanel(cfg, activeIdx) {
  clearScreen();
  const W = 58;
  const title = "CONFIRM YOUR SESSION";
  const topBar = c.cyan(c.bold("─".repeat(W)));
  const header = c.cyan(c.bold(`  ${sym.arrow} ${title}  `));
  stdout.write(`\n${topBar}\n${header}\n${topBar}\n\n`);

  // Build entries: each essential field, then extras, then actions
  const entries = [];

  for (const f of ESSENTIAL_FIELDS) {
    entries.push({ type: "field", key: f.key, label: f.label, value: cfg[f.key] || "(not set)" });
  }
  for (const f of EXTRA_FIELDS) {
    entries.push({ type: "field", key: f.key, label: f.label, value: formatValue(cfg[f.key] ?? f.default) });
  }
  entries.push({ type: "action", action: "start", label: "Start Run" });
  entries.push({ type: "action", action: "cancel", label: "Cancel" });

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const active = i === activeIdx;
    const marker = active ? c.cyan(sym.pointer) : " ";

    if (e.type === "field") {
      const valueStr = typeof e.value === "string" ? e.value : String(e.value);
      const truncated = valueStr.length > 30 ? `${valueStr.slice(0, 27)}...` : valueStr;
      const dimmed = active ? c.cyan(truncated) : c.dim(truncated);
      stdout.write(`  ${marker} ${e.label.padEnd(12)} ${dimmed}\n`);
    } else {
      const actionColor = e.action === "start" ? c.green : c.red;
      const label = e.action === "start" ? `${sym.arrow} ${e.label}` : `${sym.err} ${e.label}`;
      stdout.write(`\n  ${marker} ${actionColor(label)}\n`);
    }
  }

  // Footer
  stdout.write(`\n${c.dim(`  ↑/↓ to navigate, ↵ to select/confirm, Esc to cancel`)}`);
}

function formatValue(value) {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (value === null || value === undefined) return "(not set)";
  return String(value);
}

// ─── interactive confirmation panel ─────────────────────────────────────────

// Shows the confirmation panel with arrow-key navigation.
// Returns "start" | "cancel" | { editKey: string }.
function confirmationNav(cfg) {
  return new Promise((resolve) => {
    const entries = [];
    for (const f of ESSENTIAL_FIELDS) entries.push({ type: "field", key: f.key });
    for (const f of EXTRA_FIELDS) entries.push({ type: "field", key: f.key });
    entries.push({ type: "action", action: "start" });
    entries.push({ type: "action", action: "cancel" });

    let idx = 0;
    const draw = () => renderConfirmPanel(cfg, idx);
    draw();

    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    readline.emitKeypressEvents(stdin);

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        idx = (idx - 1 + entries.length) % entries.length;
        draw();
      } else if (key.name === "down" || key.name === "j") {
        idx = (idx + 1) % entries.length;
        draw();
      } else if (key.name === "return" || key.name === "enter") {
        const e = entries[idx];
        cleanup();
        if (e.type === "action") {
          resolve(e.action);
        } else {
          resolve({ editKey: e.key });
        }
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        resolve("cancel");
      }
    };
    stdin.on("keypress", onKey);
  });
}

// ─── step-by-step collection ────────────────────────────────────────────────

async function collectEssentials(cfg) {
  const missing = ESSENTIAL_FIELDS.filter((f) => !cfg[f.key]);
  const total = missing.length;
  if (total === 0) return;

  for (let i = 0; i < missing.length; i++) {
    const f = missing[i];
    clearScreen();
    stdout.write(`\n  ${c.bold(c.cyan(BRAND))} — step ${i + 1} of ${total}\n\n`);
    stdout.write(`  ${c.dim("─".repeat(50))}\n\n`);

    if (f.key === "personaKey") {
      // Use select picker for persona
      const personas = allPersonas();
      const k = await select(
        "Which persona?",
        Object.entries(personas).map(([k, p]) => ({ value: k, label: k, hint: p.name })),
        { default: cfg.personaKey }
      );
      cfg.personaKey = k;
    } else if (f.key === "url") {
      const ans = await text("URL to test", {
        validate: (v) => (v ? null : "Please enter a URL."),
      });
      cfg.url = normalizeUrl(ans);
    } else if (f.key === "task") {
      cfg.task = await text("What is this user trying to do? (their goal)", {
        validate: (v) => (v ? null : "Describe the goal in a few words."),
      });
    }
  }
}

// ─── edit a single field from the confirmation panel ────────────────────────

async function editField(cfg, key) {
  clearScreen();
  stdout.write(`\n  ${c.bold(c.cyan(BRAND))} — edit ${key}\n\n`);

  if (key === "personaKey") {
    const personas = allPersonas();
    cfg.personaKey = await select(
      "Persona",
      Object.entries(personas).map(([k, p]) => ({ value: k, label: k, hint: p.name })),
      { default: cfg.personaKey }
    );
  } else if (key === "url") {
    cfg.url = normalizeUrl(await text("URL to test", {
      default: cfg.url || "",
      validate: (v) => (v ? null : "Please enter a URL."),
    }));
  } else if (key === "task") {
    cfg.task = await text("Goal", {
      default: cfg.task || "",
      validate: (v) => (v ? null : "Describe the goal in a few words."),
    });
  } else if (key === "steps") {
    const f = EXTRA_FIELDS.find((f) => f.key === key);
    cfg.steps = f.coerce(await text("Max steps", { default: String(cfg.steps ?? f.default) }));
  } else if (key === "mode") {
    cfg.mode = await select("Session mode", [
      { value: "run", label: "run", hint: "full click-through session" },
      { value: "glance", label: "glance", hint: "one-screenshot first impression" },
    ], { default: cfg.mode || "run" });
  } else if (key === "device") {
    cfg.device = await select("Device preset", [
      { value: "desktop", label: "desktop", hint: "1280×800" },
      { value: "desktop-lg", label: "desktop-lg", hint: "1440×900" },
      { value: "desktop-xl", label: "desktop-xl", hint: "1920×1080" },
      { value: "tablet", label: "tablet", hint: "768×1024" },
      { value: "mobile", label: "mobile", hint: "390×844 (iPhone)" },
    ], { default: cfg.device || "desktop" });
  } else if (key === "record") {
    const on = await confirm("Enable video recording?", cfg.record);
    cfg.record = on;
  } else if (key === "a11y") {
    const on = await confirm("Enable accessibility audit?", cfg.a11y);
    cfg.a11y = on;
  } else if (key === "headed") {
    const on = await confirm("Show the browser window?", cfg.headed);
    cfg.headed = on;
  }
}

// ─── main entry point ───────────────────────────────────────────────────────

// Collects missing essential fields, shows a confirmation panel, and either
// launches the run or allows the user to edit fields before starting.
export async function guidedCollect(mode, parsed, ctx) {
  if (!isInteractive())
    throw new UserError('Interactive guided input needs a terminal.');

  // Build initial config from flags + saved config
  const flags = parsed.flags;
  const config = ctx.config || {};
  const { detectProvider: detect } = await import("./env.js");

  const cfg = {
    url:        flags.url || null,
    personaKey: flags.persona || config.persona || null,
    task:       flags.task || null,
    steps:      Number(flags.steps) || config.steps || 8,
    mode:       flags.glance ? "glance" : (mode === "glance" ? "glance" : "run"),
    device:     flags.device || config.device || "desktop",
    record:     !!flags.record,
    a11y:       !!flags.a11y,
    headed:     flags.headed !== undefined ? flags.headed : (config.headed !== undefined ? config.headed : true),
    provider:   flags.provider || process.env.PROVIDER || config.provider || detect() || "anthropic",
    model:      flags.model || config.model || null,
  };

  // Step 1: Collect missing essential fields
  await collectEssentials(cfg);

  // Step 2: Confirmation panel loop
  while (true) {
    const result = await confirmationNav(cfg);

    if (result === "start") {
      // Validate essentials
      if (!cfg.url) { clearScreen(); throw new UserError("URL is required."); }
      if (!cfg.personaKey) { clearScreen(); throw new UserError("Persona is required."); }
      if (!cfg.task) { clearScreen(); throw new UserError("Goal is required."); }

      // Check provider key (local providers like Ollama need no key)
      if (!isLocalProvider(cfg.provider) && !hasKey(cfg.provider)) {
        const p = providerInfo(cfg.provider);
        clearScreen();
        throw new UserError(
          `${p.env} is not set (needed for provider "${p.name}").\n` +
          `Get a key at ${p.signupUrl}, then either:\n` +
          `  • export ${p.env}=...\n` +
          `  • run \`crow init\` to create a .env`
        );
      }

      clearScreen();
      return cfg;
    }

    if (result === "cancel") {
      clearScreen();
      console.log(c.dim("Cancelled."));
      process.exit(0);
    }

    // Edit a field
    await editField(cfg, result.editKey);
    // Loop back to confirmation
  }
}
