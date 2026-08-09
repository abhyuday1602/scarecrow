// cli/ui.js — all terminal presentation in one place: color, symbols, spinners,
// streamed output, and the interactive prompt widgets (arrow-key select, text,
// confirm). Zero dependencies — everything is built on node:readline + ANSI codes.
//
// Color is a single switch the entry point flips once (from --color/--no-color,
// NO_COLOR, or saved config). Everything below respects it. Interactive widgets
// fall back to a plain numbered prompt when stdin/stdout isn't a TTY, and never
// hang on a non-interactive stream.

import { stdin, stdout } from "node:process";
import readline from "node:readline";
import rlp from "node:readline/promises";

// --- color ------------------------------------------------------------------
// Auto by default: on for a real terminal, off under NO_COLOR / dumb terminals.
let _color = !!stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
export const setColor = (on) => { _color = !!on; };
export const colorEnabled = () => _color;

const wrap = (open, close) => (s) => (_color ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  reset: (s) => s,
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  black: wrap(30, 39),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

// --- symbols & rules --------------------------------------------------------
export const sym = {
  ok: "✓",
  warn: "⚠",
  err: "✗",
  info: "ℹ",
  bullet: "•",
  arrow: "▶",
  pointer: "❯",
  dot: "·",
};
// Layout width. Shrink-only: 60 stays the design width on any normal terminal, but a
// window narrower than that gets rules and panel borders that fit instead of wrapping
// every one of them onto a ragged second line. Read at call time, so a mid-run resize
// is picked up rather than frozen at import.
export const termWidth = () => Math.max(20, Math.min(60, stdout.columns || 60));

export const rule = (n = termWidth()) => "─".repeat(n);

// A section heading: a bold/colored title above a full rule. Used for FINDINGS, etc.
export function heading(title, color = c.cyan) {
  return `\n${color(c.bold(title))}\n`;
}

// A compact titled panel — a labelled top rule, indented body lines, a bottom rule.
// Avoids per-line border math (which would need ANSI-aware width), so colored body
// content lays out correctly.
export function panel(title, lines, { color = c.cyan, width = termWidth() } = {}) {
  const label = ` ${title} `;
  const left = 2;
  const top = color("─".repeat(left)) + color(c.bold(label)) + color("─".repeat(Math.max(0, width - left - label.length)));
  const out = [top];
  for (const ln of lines) out.push(`  ${  ln}`);
  out.push(color("─".repeat(width)));
  return out.join("\n");
}

// --- spinner (TTY-only; static one-liner otherwise) -------------------------
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function spinner(msg) {
  if (!stdout.isTTY || !_color) {
    stdout.write(c.dim(`  ${  msg  }\n`));
    return () => {};
  }
  let i = 0;
  stdout.write(c.dim(`  ${  spinnerFrames[0]  } ${  msg}`));
  const id = setInterval(
    () => stdout.write(`\r${  c.dim(`  ${  spinnerFrames[i++ % spinnerFrames.length]  } ${  msg}`)}`),
    80
  );
  return () => {
    clearInterval(id);
    stdout.write(`\r${  " ".repeat(stripAnsi(msg).length + 4)  }\r`);
  };
}

// A no-op spinner factory, for modes (e.g. --json) where stdout must stay clean.
export const noSpinner = () => () => {};

// Bridges model latency and streamed reasoning: spinner until the first token, then
// streams the (dimmed) text. `indent` prefixes the first line. Call end() when done.
export function streamPrinter(label = "Thinking …", indent = true) {
  const stop = spinner(label);
  let started = false, lastChar = "";
  const onChunk = (text) => {
    if (!text) return;
    if (!started) { stop(); if (indent) stdout.write(c.dim("  ")); started = true; }
    stdout.write(c.dim(text));
    lastChar = text[text.length - 1];
  };
  const end = () => {
    if (!started) { stop(); return; }
    if (lastChar !== "\n") stdout.write("\n");
  };
  return { onChunk, end };
}

// Live countdown: writes a spinner + message that updates every second, then
// cleans up the line when done. Designed for the rate-limit retry flow.
export async function waitWithCountdown(ms, label) {
  const secs = Math.ceil(ms / 1000);
  if (!stdout.isTTY || !_color) {
    stdout.write(c.yellow(`  ${label} — retrying in ${secs}s\n`));
    await new Promise((r) => setTimeout(r, ms));
    return;
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let remaining = secs;
  let frame = 0;
  let drawn = 0; // widest line actually written, so the clear below erases all of it
  const render = () => {
    const line = `  ${frames[frame++ % frames.length]} ${label} — retrying in ${remaining}s   `;
    drawn = Math.max(drawn, line.length);
    stdout.write(`\r${c.yellow(line)}`);
  };
  render();
  const tick = setInterval(() => {
    remaining--;
    if (remaining > 0) render();
  }, 1000);
  const spin = setInterval(render, 80);
  await new Promise((r) => setTimeout(r, ms));
  clearInterval(tick);
  clearInterval(spin);
  // A fixed 60 left residue behind any longer status line (a long label passes that easily).
  stdout.write(`\r${" ".repeat(drawn)}\r`);
}

// --- interactive prompts ----------------------------------------------------
export const isInteractive = () => !!stdin.isTTY && !!stdout.isTTY;

class PromptCancelled extends Error {
  constructor() { super("cancelled"); this.name = "PromptCancelled"; this.cancelled = true; }
}
export const isCancel = (e) => e instanceof PromptCancelled || e?.cancelled === true;

// An expected, user-facing error (bad input, missing key, …). The entry point prints
// its message plainly — no stack, no "something failed" prefix.
export class UserError extends Error {
  constructor(message) { super(message); this.name = "UserError"; this.user = true; }
}

// Free-text prompt. Shows a default in parens; Enter accepts it. `validate` returns
// an error string to re-ask, or null/undefined to accept.
export async function text(question, { default: def = "", validate } = {}) {
  if (!isInteractive()) {
    if (def) return def;
    throw new Error(`"${question}" needs an interactive terminal (or pass it as a flag).`);
  }
  const rl = rlp.createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const hint = def ? c.dim(` (${def})`) : "";
      let ans;
      try {
        ans = (await rl.question(`${c.cyan("?")} ${c.bold(question)}${hint} `)).trim();
      } catch {
        throw new PromptCancelled(); // Ctrl-C / closed stream
      }
      const val = ans || def;
      if (validate) {
        const err = validate(val);
        if (err) { stdout.write(`${c.red(`  ${err}`)  }\n`); continue; }
      }
      return val;
    }
  } finally {
    rl.close();
  }
}

// Masked text prompt for secrets (API keys): echoes • per character so the value
// never lands in the terminal or scrollback. Backspace edits; Enter accepts;
// Esc / Ctrl-C cancels. Requires a TTY — there is no safe non-interactive fallback.
export function password(question) {
  if (!isInteractive()) {
    return Promise.reject(new Error(`"${question}" needs an interactive terminal.`));
  }
  return new Promise((resolve, reject) => {
    let value = "";
    stdout.write(`${c.cyan("?")} ${c.bold(question)} `);

    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\n");
    };

    const onKey = (str, key) => {
      if (key?.name === "return" || key?.name === "enter") { cleanup(); resolve(value.trim()); }
      else if (key?.name === "escape" || (key?.ctrl && key.name === "c")) { cleanup(); reject(new PromptCancelled()); }
      else if (key?.name === "backspace") {
        if (value) { value = value.slice(0, -1); stdout.write("\b \b"); }
      } else if (str && !key?.ctrl && !key?.meta) {
        // Printable input only — a paste arrives as one multi-char str.
        const clean = str.replace(/[\r\n]/g, "");
        value += clean;
        stdout.write("•".repeat(clean.length));
      }
    };
    stdin.on("keypress", onKey);
  });
}

// Yes/no. `def` decides what a bare Enter means and which letter is capitalized.
export async function confirm(question, def = false) {
  const ans = await text(`${question} ${c.dim(def ? "(Y/n)" : "(y/N)")}`);
  if (!ans) return def;
  return /^y(es)?$/i.test(ans);
}

// choices: [{ value, label, hint? }]. Arrow-key picker on a TTY; numbered prompt
// otherwise. Returns the chosen `value`. Throws PromptCancelled on Ctrl-C / Esc.
export function select(question, choices, { default: defValue } = {}) {
  if (!isInteractive()) return numberedSelect(question, choices, { default: defValue });

  return new Promise((resolve, reject) => {
    let idx = choices.findIndex((ch) => ch.value === defValue);
    if (idx < 0) idx = 0;

    const draw = (ch, on) =>
      `  ${on ? c.cyan(sym.pointer) : " "} ${on ? c.cyan(ch.label) : ch.label}${ 
      ch.hint ? c.dim(`  ${  ch.hint}`) : ""}`;

    stdout.write(`${c.cyan("?")} ${c.bold(question)} ${c.dim("(↑/↓, ↵ to select)")}\n`);
    stdout.write(`${choices.map((ch, i) => draw(ch, i === idx)).join("\n")  }\n`);

    const redraw = () => {
      stdout.write(`\x1b[${choices.length}A`);
      for (let i = 0; i < choices.length; i++) stdout.write(`\x1b[2K${  draw(choices[i], i === idx)  }\n`);
    };

    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") { idx = (idx - 1 + choices.length) % choices.length; redraw(); }
      else if (key.name === "down" || key.name === "j") { idx = (idx + 1) % choices.length; redraw(); }
      else if (key.name === "return" || key.name === "enter") {
        cleanup();
        // Collapse the list into a one-line summary of the choice.
        stdout.write(`\x1b[${choices.length + 1}A\r\x1b[J`);
        stdout.write(`${c.green(sym.ok)} ${c.bold(question)} ${c.dim(sym.dot)} ${c.cyan(choices[idx].label)}\n`);
        resolve(choices[idx].value);
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        stdout.write("\n");
        reject(new PromptCancelled());
      }
    };
    stdin.on("keypress", onKey);
  });
}

// Fallback picker for non-TTY (or when raw mode isn't available): numbered list.
async function numberedSelect(question, choices, { default: defValue } = {}) {
  if (!stdin.isTTY) {
    // No way to ask — use the default if we have one, else fail loudly.
    const def = choices.find((ch) => ch.value === defValue);
    if (def) return def.value;
    throw new Error(`"${question}" needs an interactive terminal (or pass it as a flag).`);
  }
  const rl = rlp.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`${c.cyan("?")} ${c.bold(question)}\n`);
    choices.forEach((ch, i) =>
      stdout.write(`  ${c.bold(String(i + 1))}. ${ch.label}${ch.hint ? c.dim(`  ${  ch.hint}`) : ""}\n`)
    );
    const defIdx = choices.findIndex((ch) => ch.value === defValue);
    const defHint = defIdx >= 0 ? c.dim(` (${defIdx + 1})`) : "";
    for (;;) {
      const ans = (await rl.question(`Pick a number or name${defHint}: `)).trim();
      if (!ans && defIdx >= 0) return choices[defIdx].value;
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
      const byVal = choices.find((ch) => ch.value === ans);
      if (byVal) return byVal.value;
      stdout.write(`${c.red(`  Enter a number between 1 and ${choices.length}, or a name.`)  }\n`);
    }
  } finally {
    rl.close();
  }
}
