// cli/tui/input.js — the resident input bar. A controlled text buffer with a cursor,
// built on Ink's useInput so we fully control the advanced behavior:
//   • the command list appears as a popup above the bar whenever the buffer starts with "/"
//   • type after "/" to filter; ↑/↓ pick; ↵ runs the highlighted command (or submits raw
//     text as a goal/URL when the buffer doesn't start with "/")
//   • Tab autocompletes the highlighted command
//   • Shift+Tab bubbles up to cycle the agent mode
//   • ↑/↓ on a non-"/" buffer walk the input history
//   • Ctrl+A/E jump to line start/end; Ctrl+←/→ (or Alt/Option+←/→) jump by word — readline
//     conventions, since Ink's useInput can't see mouse clicks or Home/End (see jumpWord below)
//   • a paste arrives as one multi-char `input`; embedded CR/LF is sanitized to a space so a
//     multi-line clipboard paste can't split this single-line buffer across rows
//   • collecting: bar becomes a focused single-purpose field (url / persona / task)

import { useState } from "react";
import { useInput } from "ink";
import { html } from "./html.js";
import { filterCommands } from "./slash.js";
import { useTheme } from "./themeProvider.js";

// Strip embedded CR/LF from pasted text (replaced with a space, not dropped, so words on
// either side of a line break don't get mashed together). A paste with internal line breaks
// (copied from a notes app, email, etc.) otherwise lands raw in this single-line buffer.
const sanitizePaste = (s) => s.replace(/\r\n|\r|\n/g, " ");

// Move `cur` one "word" left (dir -1) or right (dir +1) in `buf`, readline-style: skip any
// run of whitespace in that direction first, then skip the run of non-whitespace. Used by
// Ctrl+←/→ (and Alt/Option+←/→) for fast repositioning in long single-line text.
export function jumpWord(buf, cur, dir) {
  let i = cur;
  if (dir < 0) {
    while (i > 0 && /\s/.test(buf[i - 1])) i--;
    while (i > 0 && !/\s/.test(buf[i - 1])) i--;
  } else {
    while (i < buf.length && /\s/.test(buf[i])) i++;
    while (i < buf.length && !/\s/.test(buf[i])) i++;
  }
  return i;
}

// Popup shown above the bar (only when the buffer starts with "/"). The list can be far
// longer than fits, so it's a scrolling window of WIN items that follows the selection:
// `start` is clamped so the highlighted `index` is always on screen, with dim "N more"
// markers when items are hidden above/below.
const WIN = 8;
function SlashMenu({ items, index }) {
  const { theme } = useTheme();
  if (!items.length) return null;
  const start = items.length > WIN
    ? Math.min(Math.max(0, index - Math.floor(WIN / 2)), items.length - WIN)
    : 0;
  const shown = items.slice(start, start + WIN);
  const hiddenAbove = start;
  const hiddenBelow = items.length - (start + shown.length);
  return html`
    <Box flexDirection="column" marginLeft=${1} marginBottom=${0}>
      ${hiddenAbove > 0 ? html`<Text dimColor>  ↑ ${hiddenAbove} more</Text>` : null}
      ${shown.map((cmd, i) => {
        const sel = start + i === index;
        return html`
          <Text key=${cmd.name} color=${sel ? theme.accent : undefined}>
            ${sel ? "❯" : " "} <Text bold=${sel}>/${cmd.name}</Text>${cmd.args ? ` ${  cmd.args}` : ""}  <Text dimColor>${cmd.summary}</Text>
          </Text>`;
      })}
      ${hiddenBelow > 0 ? html`<Text dimColor>  ↓ ${hiddenBelow} more</Text>` : null}
    </Box>`;
}

export function Prompt({ active, onSubmit, onShiftTab, history = [], collecting = null, postRun = false, loadedGoal = "" }) {
  const { theme } = useTheme();
  const [buf, setBuf] = useState("");
  const [cur, setCur] = useState(0);
  const [menuIdx, setMenuIdx] = useState(0);
  const [histIdx, setHistIdx] = useState(-1);

  // Only show commands when the buffer starts with "/". Strip the "/" to get
  // the query, then filter by prefix/substring.
  const q = buf.startsWith("/") ? buf.slice(1) : "";
  const filteredItems = collecting ? [] : (buf.startsWith("/") ? filterCommands(q) : []);
  const mIdx = filteredItems.length ? Math.min(menuIdx, filteredItems.length - 1) : 0;

  // Show the menu only when typing a "/" command (not when typing URLs/goals)
  const showMenu = collecting ? false : buf.startsWith("/") && filteredItems.length > 0;

  const reset = () => { setBuf(""); setCur(0); setMenuIdx(0); setHistIdx(-1); };

  // Contextual placeholder while the bar is collecting a missing field
  const placeholder =
    postRun ? "Type a goal, or /home to start fresh" :
    collecting === "__confirm__" ? "Press Enter to start the run, or N to go home" :
    collecting === "url"     ? "Enter the URL to test…" :
    collecting === "task"    ? "What's the goal?" :
    collecting === "persona" ? "Which persona? (type a key, or ↵ to open picker)" :
    loadedGoal               ? "↵ to run, or type a new goal" :
                               "Describe a task to test…";

  useInput((input, key) => {
    if (key.tab && key.shift) { onShiftTab?.(); return; }

    // ── collecting mode: simple focused field ───────────────────────────────
    if (collecting) {
      if (key.return) { onSubmit(buf.trim()); reset(); return; }
      if (key.escape) { reset(); return; } // buffer cleared; global handler in app.js calls cancelCollect()
      if (key.backspace || key.delete) {
        if (cur > 0) { setBuf(buf.slice(0, cur - 1) + buf.slice(cur)); setCur(cur - 1); }
        return;
      }
      if (key.ctrl && input === "a") { setCur(0); return; }
      if (key.ctrl && input === "e") { setCur(buf.length); return; }
      if ((key.leftArrow || key.rightArrow) && (key.ctrl || key.meta)) {
        setCur(jumpWord(buf, cur, key.leftArrow ? -1 : 1)); return;
      }
      if (key.leftArrow)  { setCur((c) => Math.max(0, c - 1)); return; }
      if (key.rightArrow) { setCur((c) => Math.min(buf.length, c + 1)); return; }
      if (key.ctrl || key.meta) return; // Ctrl+C et al. handled globally
      if (input) {
        const clean = sanitizePaste(input);
        setBuf(buf.slice(0, cur) + clean + buf.slice(cur)); setCur(cur + clean.length);
      }
      return;
    }

    // ── normal mode ──────────────────────────────────────────────────────────
    if (key.return) {
      // Run the highlighted command when the buffer is a bare "/command" without args;
      // otherwise submit the raw text as a goal/URL.
      if (buf.startsWith("/") && filteredItems.length && !buf.trim().includes(" ")) {
        const cmd = filteredItems[mIdx];
        // Commands with required args (<arg>): fill the bar so user can type the value
        if (cmd.args && cmd.args.startsWith("<")) {
          const next = `/${  cmd.name  } `;
          setBuf(next); setCur(next.length); setMenuIdx(0);
        } else {
          onSubmit(`/${  cmd.name}`);
          reset();
        }
      } else {
        onSubmit(buf.trim());
        reset();
      }
      return;
    }

    if (key.tab) {
      if (filteredItems.length) {
        const next = `/${  filteredItems[mIdx].name  } `;
        setBuf(next); setCur(next.length); setMenuIdx(0);
      }
      return;
    }

    if (key.escape) { reset(); return; }

    if (key.upArrow) {
      if (showMenu && filteredItems.length) {
        setMenuIdx((mIdx - 1 + filteredItems.length) % filteredItems.length);
        return;
      }
      // history: when the command menu isn't visible
      if (history.length) {
        const ni = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(ni); setBuf(history[ni]); setCur(history[ni].length);
      }
      return;
    }
    if (key.downArrow) {
      if (showMenu && filteredItems.length) {
        setMenuIdx((mIdx + 1) % filteredItems.length);
        return;
      }
      if (histIdx >= 0) {
        const ni = histIdx + 1;
        if (ni >= history.length) { reset(); }
        else { setHistIdx(ni); setBuf(history[ni]); setCur(history[ni].length); }
      }
      return;
    }

    if (key.ctrl && input === "a") { setCur(0); return; }
    if (key.ctrl && input === "e") { setCur(buf.length); return; }
    if ((key.leftArrow || key.rightArrow) && (key.ctrl || key.meta)) {
      setCur(jumpWord(buf, cur, key.leftArrow ? -1 : 1)); return;
    }
    if (key.leftArrow)  { setCur((c) => Math.max(0, c - 1)); return; }
    if (key.rightArrow) { setCur((c) => Math.min(buf.length, c + 1)); return; }

    if (key.backspace || key.delete) {
      if (cur > 0) { setBuf(buf.slice(0, cur - 1) + buf.slice(cur)); setCur(cur - 1); }
      setMenuIdx(0); setHistIdx(-1);
      return;
    }

    if (key.ctrl || key.meta) return; // let global handler deal with Ctrl combos
    if (input) {
      const clean = sanitizePaste(input);
      setBuf(buf.slice(0, cur) + clean + buf.slice(cur));
      setCur(cur + clean.length);
      setMenuIdx(0); setHistIdx(-1);
    }
  }, { isActive: active });

  const before  = buf.slice(0, cur);
  const at      = buf.slice(cur, cur + 1) || " ";
  const after   = buf.slice(cur + 1);

  // Rounded, full-width input box (Claude Code style). The mode/provider/url status now
  // lives in the App's StatusFooter, so the box holds only the prompt glyph + text/cursor.
  return html`
    <Box flexDirection="column">
      ${showMenu ? html`<${SlashMenu} items=${filteredItems} index=${mIdx} />` : null}
      <Box borderStyle="round" borderColor=${active ? theme.accent : theme.border} paddingX=${1}>
        <Text color=${active ? theme.accent : theme.muted}>${"› "}</Text>
        <Text>${before}<Text inverse>${at}</Text>${after}${buf === "" ? html`<Text dimColor>${placeholder}</Text>` : ""}</Text>
      </Box>
    </Box>`;
}
