// cli/tui/overlays.js — modal-ish overlays that temporarily take over input from the
// main bar: a generic arrow-key Picker (used for /persona, /provider, /persona-remove, the
// unified /model picker, …), the stepped /persona-add wizard, and the masked ProviderKeyForm
// (paste an API key from /provider). Each owns an Ink useInput while it's mounted; the App
// renders only one overlay (or the prompt) at a time, so there's no input contention.

import { useState, useEffect } from "react";
import { useInput } from "ink";
import { html } from "./html.js";
import { useTheme } from "./themeProvider.js";
import { addPersona, isBuiltin, KEY_RE } from "../personas-store.js";

// Does an item's label/group text contain the (already-lowercased) query?
const matchesQuery = (it, q) =>
  (it.label && it.label.toLowerCase().includes(q)) || (it.group && it.group.toLowerCase().includes(q));

// A centered modal dialog: rounded, theme-accented border, a title bar, the choices, and
// the key hints inside the box. The App renders exactly one of these at a time (input goes
// inactive while it's open), so it fully owns the keyboard.
//
// Items are normally `{ value, label, hint? }`. Two opt-in extensions, used by the unified
// /model picker to show "provider name, then its models":
//   - A `{ header }` item (no `value`) is a non-selectable section label — navigation skips
//     it, and `onPick` never fires for it. Give a selectable item a `group` (the provider
//     name) so search can match it even when the model's own label doesn't.
//   - `filterable: true` turns on a type-to-filter query line above the list; while on,
//     printable keys edit the query instead of vim-style `j`/`k` navigation (arrows still
//     navigate). Only items whose label/group match are shown; a header stays visible only
//     while at least one item in its group still matches.
//
// onHighlight (optional): called with the current item's value on mount and whenever the
// selection moves — used by the theme picker to preview a theme live as you arrow through it.
export function Picker({ title, items, initial, onPick, onCancel, onHighlight, filterable = false }) {
  const { theme } = useTheme();
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const view = (!filterable || !q) ? items : items.filter((it, i) => {
    if (it.value === undefined) {
      // Header: keep it only if a following item in its block (up to the next header) matches.
      for (let j = i + 1; j < items.length && items[j].value !== undefined; j++) {
        if (matchesQuery(items[j], q)) return true;
      }
      return false;
    }
    return matchesQuery(it, q);
  });
  const firstSelectable = Math.max(0, items.findIndex((i) => i.value !== undefined));
  const start = items.findIndex((i) => i.value === initial);
  const [idx, setIdx] = useState(start >= 0 ? start : firstSelectable);

  // Re-clamp onto a selectable row whenever the filtered view changes shape.
  useEffect(() => {
    if (!view[idx] || view[idx].value === undefined) {
      const next = view.findIndex((i) => i.value !== undefined);
      setIdx(next >= 0 ? next : 0);
    }
  }, [query]);

  // Fire the live-preview callback for the highlighted item (mount + every move).
  // Intentionally keyed only on `idx` so a preview-driven re-render doesn't refire.
  useEffect(() => { onHighlight?.(view[idx]?.value); }, [idx]);

  const move = (dir) => setIdx((i) => {
    const n = view.length;
    if (!n) return i;
    let next = i;
    for (let step = 0; step < n; step++) {
      next = (next + dir + n) % n;
      if (view[next] && view[next].value !== undefined) return next;
    }
    return i;
  });

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { const it = view[idx]; if (it && it.value !== undefined) onPick(it.value); return; }
    if (key.upArrow) { move(-1); return; }
    if (key.downArrow) { move(1); return; }
    if (!filterable) {
      if (input === "k") move(-1);
      else if (input === "j") move(1);
      return;
    }
    if (key.backspace || key.delete) { setQuery((s) => s.slice(0, -1)); return; }
    if (key.ctrl || key.meta) return;
    if (input) setQuery((s) => s + input);
  });

  // Long lists (e.g. a provider's live model listing) scroll inside a fixed window,
  // keeping the highlight centered where possible.
  const MAX_VISIBLE = 12;
  const winStart = view.length <= MAX_VISIBLE
    ? 0
    : Math.max(0, Math.min(idx - Math.floor(MAX_VISIBLE / 2), view.length - MAX_VISIBLE));
  const visible = view.slice(winStart, winStart + MAX_VISIBLE);
  const hasSelectable = view.some((i) => i.value !== undefined);

  return html`
    <Box flexDirection="column" borderStyle="round" borderColor=${theme.accent} paddingX=${2} paddingY=${1} width=${60}>
      <Box marginBottom=${1}>
        <Text color=${theme.accent} bold>${title}</Text>
      </Box>
      ${filterable ? html`<Box marginBottom=${1}><Text color=${theme.muted}>⌕ </Text><Text>${query}</Text><Text inverse> </Text></Box>` : null}
      ${!hasSelectable ? html`<Text color=${theme.muted}>${filterable && q ? "(no matches)" : "(nothing to choose)"}</Text>` : null}
      ${winStart > 0 ? html`<Text color=${theme.muted}>  ↑ ${winStart} more</Text>` : null}
      ${visible.map((it, vi) => {
        const i = winStart + vi;
        if (it.value === undefined) {
          return html`<Text key=${`h-${i}`} color=${theme.muted} bold>${it.header}</Text>`;
        }
        return html`
          <Text key=${it.value} color=${i === idx ? theme.accent : undefined}>
            ${i === idx ? "❯" : " "} ${it.group ? "  " : ""}${it.label}${it.hint ? html`  <Text color=${theme.muted}>${it.hint}</Text>` : ""}
          </Text>`;
      })}
      ${winStart + MAX_VISIBLE < view.length ? html`<Text color=${theme.muted}>  ↓ ${view.length - winStart - MAX_VISIBLE} more</Text>` : null}
      <Box marginTop=${1}><Text color=${theme.muted}>${filterable ? "type to filter · " : ""}↑/↓ move · ↵ select · esc cancel</Text></Box>
    </Box>`;
}

const FIELDS = [
  { k: "key", label: "Key — a short slug, e.g. qa-tester" },
  { k: "name", label: "Name — e.g. Tessa — meticulous QA tester" },
  { k: "description", label: "Description — the persona's voice & behavior (this becomes the agent's prompt)" },
];
const REVIEW = FIELDS.length;        // the step index of the review / confirm screen
const STEPS = FIELDS.length + 1;     // total steps shown to the user (fields + review)

// A four-step wizard for creating a persona: key → name → description → review & confirm.
// ↵ advances at every step; ←/→ juggle between steps (values are preserved, so you can
// step back, fix, and return). The review step is an explicit ↑/↓ Yes/No choice — Yes adds
// the persona, No discards the whole flow. Esc cancels at any point. addPersona stays the
// final validator + atomic writer.
export function PersonaAddForm({ onSave, onCancel }) {
  const { theme } = useTheme();
  const [step, setStep] = useState(0);
  const [vals, setVals] = useState({ key: "", name: "", description: "" });
  const [buf, setBuf] = useState("");
  const [err, setErr] = useState("");
  const [confirmIdx, setConfirmIdx] = useState(0); // review: 0 = yes/add, 1 = no/discard
  const f = FIELDS[step]; // undefined on the review step
  const onReview = step === REVIEW;

  // Move to a step, seeding the buffer with that field's current value so back/forth edits
  // never lose what was typed. Clears any pending error.
  const goTo = (next) => { setStep(next); setBuf(FIELDS[next] ? vals[FIELDS[next].k] || "" : ""); setErr(""); };
  // Back one step; stash the current raw buffer first (no validation — nothing is dropped).
  const goBack = () => {
    if (step === 0) return;
    if (f) setVals((v) => ({ ...v, [f.k]: buf }));
    goTo(step - 1);
  };
  // Forward from a field: validate, store, advance (last field → review).
  const advance = () => {
    const v = buf.trim();
    if (!v) { setErr("required"); return; }
    if (f.k === "key") {
      if (!KEY_RE.test(v)) { setErr("lowercase letters, digits or hyphens only"); return; }
      if (isBuiltin(v)) { setErr(`"${v}" is a built-in persona — pick another key`); return; }
    }
    setVals((prev) => ({ ...prev, [f.k]: v }));
    if (step + 1 === REVIEW) setConfirmIdx(0);
    goTo(step + 1);
  };
  const save = () => {
    try { onSave(addPersona(vals.key, { name: vals.name, description: vals.description })); }
    catch (e) { setErr(e.message); }
  };

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }

    if (onReview) {
      if (key.upArrow || key.downArrow) { setConfirmIdx((i) => 1 - i); return; }
      if (key.return) { if (confirmIdx === 0) save(); else onCancel(); return; }
      if (key.leftArrow) { goTo(REVIEW - 1); return; }
      return;
    }

    if (key.leftArrow) { goBack(); return; }
    if (key.return || key.rightArrow) { advance(); return; }

    if (key.backspace || key.delete) { setBuf((b) => b.slice(0, -1)); return; }
    if (key.ctrl || key.meta) return;
    if (input) setBuf((b) => b + input);
  });

  const dialog = (children) => html`
    <Box flexDirection="column" borderStyle="round" borderColor=${theme.accent} paddingX=${2} paddingY=${1} width=${60}>
      ${children}
    </Box>`;

  if (onReview) {
    const descLines = (vals.description || "").split("\n");
    const choices = ["Yes — add this persona", "No — discard it"];
    return dialog(html`
      <Box marginBottom=${1}>
        <Text color=${theme.accent} bold>Persona profile</Text>
        <Text color=${theme.muted}>  step ${STEPS} of ${STEPS} · review</Text>
      </Box>
      <Text><Text color=${theme.muted}>Key:  </Text>${vals.key}</Text>
      <Text><Text color=${theme.muted}>Name: </Text>${vals.name}</Text>
      <Box flexDirection="column" marginTop=${1}>
        <Text color=${theme.muted}>Description:</Text>
        ${descLines.map((l, i) => html`<Text key=${i}>  ${l || " "}</Text>`)}
      </Box>
      <Box marginTop=${1}><Text color=${theme.muted}>Use it with  /persona ${vals.key}</Text></Box>
      <Box flexDirection="column" marginTop=${1}>
        ${choices.map((label, i) => html`
          <Text key=${label} color=${i === confirmIdx ? theme.accent : undefined}>
            ${i === confirmIdx ? "❯" : " "} ${label}
          </Text>`)}
      </Box>
      ${err ? html`<Text color=${theme.error}>${err}</Text>` : null}
      <Box marginTop=${1}><Text color=${theme.muted}>↑/↓ choose · ↵ confirm · ❮ back · esc cancel</Text></Box>`);
  }

  const bufLines = buf.split("\n");
  const hint = `↵ next${step > 0 ? " · ❮ ❯ steps" : ""} · esc cancel`;
  return dialog(html`
    <Box marginBottom=${1}>
      <Text color=${theme.accent} bold>New persona</Text>
      <Text color=${theme.muted}>  step ${step + 1} of ${STEPS} · ${f.k}</Text>
    </Box>
    ${FIELDS.slice(0, step).map((pf) => html`
      <Text key=${pf.k}><Text color=${theme.muted}>${`${pf.k}:`.padEnd(6)}</Text>${(vals[pf.k] || "").split("\n")[0]}${(vals[pf.k] || "").includes("\n") ? " …" : ""}</Text>`)}
    <Box marginTop=${step > 0 ? 1 : 0}><Text color=${theme.muted}>${f.label}</Text></Box>
    <Box flexDirection="column">
      ${bufLines.map((l, i) => html`
        <Text key=${i}>${l}${i === bufLines.length - 1 ? html`<Text inverse> </Text>` : null}</Text>`)}
    </Box>
    ${err ? html`<Text color=${theme.error}>${err}</Text>` : null}
    <Box marginTop=${1}><Text color=${theme.muted}>${hint}</Text></Box>`);
}

// A simple yes/no confirmation dialog.
export function ConfirmDialog({ message: msg, onConfirm, onCancel, confirmLabel = "Yes", cancelLabel = "No" }) {
  const { theme } = useTheme();
  const [idx, setIdx] = useState(0);

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { if (idx === 0) onConfirm(); else onCancel(); return; }
    if (key.upArrow || key.downArrow) setIdx((i) => 1 - i);
  });

  return html`
    <Box flexDirection="column" borderStyle="round" borderColor=${theme.warning} paddingX=${2} paddingY=${1} width=${50}>
      <Box marginBottom=${1}><Text bold>${msg}</Text></Box>
      <Box flexDirection="column">
        <Text color=${idx === 0 ? theme.accent : undefined}>${idx === 0 ? "❯" : " "} ${confirmLabel}</Text>
        <Text color=${idx === 1 ? theme.accent : undefined}>${idx === 1 ? "❯" : " "} ${cancelLabel}</Text>
      </Box>
      <Box marginTop=${1}><Text color=${theme.muted}>↑/↓ navigate · ↵ confirm · esc cancel</Text></Box>
    </Box>`;
}

// A masked single-field prompt for pasting a provider's API key (opened from /provider when
// the chosen provider has no key). The value is echoed as • so it never lands in the
// terminal or scrollback. We can't reuse ui.js's readline password() here — Ink owns stdin
// in raw mode — so input is captured via useInput just like PersonaAddForm, only masked.
// A paste arrives as one multi-char `input`; CR/LF is stripped so it can't inject .env lines.
// Enter (non-empty) saves; Esc cancels. The App does the actual .env write + process.env set.
export function ProviderKeyForm({ provider, onSave, onCancel }) {
  const { theme } = useTheme();
  const [buf, setBuf] = useState("");
  const [err, setErr] = useState("");

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) {
      const v = buf.trim();
      if (!v) { setErr("paste your API key, or press esc to cancel"); return; }
      onSave(v);
      return;
    }
    if (key.backspace || key.delete) { setBuf((b) => b.slice(0, -1)); return; }
    if (key.ctrl || key.meta) return;
    if (input) { setBuf((b) => b + input.replace(/[\r\n]/g, "")); setErr(""); }
  });

  return html`
    <Box flexDirection="column" borderStyle="round" borderColor=${theme.accent} paddingX=${2} paddingY=${1} width=${60}>
      <Box marginBottom=${1}>
        <Text color=${theme.accent} bold>Add ${provider.name} API key</Text>
      </Box>
      <Text color=${theme.muted}>Get a key:  ${provider.signupUrl}</Text>
      <Text color=${theme.muted}>Saves to ${provider.env} in .env (mode 600).</Text>
      <Box marginTop=${1}>
        <Text color=${theme.muted}>key: </Text>
        <Text>${"•".repeat(buf.length)}</Text><Text inverse> </Text>
      </Box>
      ${err ? html`<Text color=${theme.error}>${err}</Text>` : null}
      <Box marginTop=${1}><Text color=${theme.muted}>↵ save · esc cancel</Text></Box>
    </Box>`;
}

// A review overlay for creating a config profile: shows the profile name and all
// settings that will be saved, with Save / Cancel confirmation via arrow keys.
export function ProfileCreateForm({ profileName, settings, onSave, onCancel }) {
  const { theme } = useTheme();
  const [idx, setIdx] = useState(0);

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { if (idx === 0) onSave(); else onCancel(); return; }
    if (key.upArrow || key.downArrow) setIdx((i) => 1 - i);
  });

  const entries = Object.entries(settings).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return html`
    <Box flexDirection="column" borderStyle="round" borderColor=${theme.accent} paddingX=${2} paddingY=${1} width=${60}>
      <Box marginBottom=${1}>
        <Text color=${theme.accent} bold>Create profile</Text>
      </Box>
      <Text><Text color=${theme.muted}>Profile: </Text><Text>${profileName}</Text></Text>
      <Box flexDirection="column" marginTop=${1}>
        ${entries.map(([k, v]) => html`
          <Text key=${k}><Text color=${theme.muted}>${`${k}:`.padEnd(16)}</Text>${String(v)}</Text>`)}
      </Box>
      <Box marginTop=${1}>
        <Text color=${idx === 0 ? theme.accent : undefined}>${idx === 0 ? "❯" : " "} Save</Text>
        <Text>  </Text>
        <Text color=${idx === 1 ? theme.accent : undefined}>${idx === 1 ? "❯" : " "} Cancel</Text>
      </Box>
      <Box marginTop=${1}><Text color=${theme.muted}>↑/↓ choose · ↵ confirm · esc cancel</Text></Box>
    </Box>`;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function StartingOllamaOverlay({ onCancel, message = "Starting Ollama server..." }) {
  const { theme } = useTheme();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 100);
    return () => clearInterval(interval);
  }, []);

  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
  });

  return html`
    <Box flexDirection="column" borderStyle="round" borderColor=${theme.accent} paddingX=${2} paddingY=${1} width=${50}>
      <Box marginBottom=${1}>
        <Text color=${theme.accent} bold>Ollama</Text>
      </Box>
      <Box>
        <Text color=${theme.muted}>${SPINNER[frame]}</Text>
        <Text> ${message}</Text>
      </Box>
      <Box marginTop=${1}><Text color=${theme.muted}>esc cancel</Text></Box>
    </Box>`;
}

const MAX_LOG_LINES = 30;

export function OllamaInstallOverlay({ proc, onCancel }) {
  const { theme } = useTheme();
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState("installing");

  useEffect(() => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      const parts = buf.split("\n");
      buf = parts.pop() || "";
      for (const raw of parts) {
        const t = raw.replace(/\r/g, "").trim();
        if (t) setLines((prev) => [...prev.slice(-(MAX_LOG_LINES - 1)), t]);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("close", (code) => {
      setStatus(code === 0 ? "done" : "error");
    });
    return () => {
      proc.stdout?.removeListener("data", onData);
      proc.stderr?.removeListener("data", onData);
    };
  }, []);

  useInput((input, key) => {
    if (key.escape && status === "installing") { try { proc.kill("SIGTERM"); } catch { /* proc already dead */ } onCancel(); }
  });

  return html`
    <Box flexDirection="column" borderStyle="round" borderColor=${theme.accent} paddingX=${2} paddingY=${1} width=${70}>
      <Box marginBottom=${1}>
        <Text color=${theme.accent} bold>Installing Ollama</Text>
      </Box>
      <Box flexDirection="column">
        ${lines.map((l, i) => html`<Text key=${i} dimColor>${l.slice(0, 100)}</Text>`)}
      </Box>
      <Box marginTop=${1}>
        ${status === "installing" ? html`<Text color=${theme.muted}>installing…  esc cancel</Text>` :
          status === "done" ? html`<Text color="green">Installation complete</Text>` :
          html`<Text color=${theme.error}>Installation failed. Run the command manually.</Text>`}
      </Box>
    </Box>`;
}

const BAR_W = 55;

function progressBar(pct) {
  const filled = Math.round((pct / 100) * BAR_W);
  const empty = BAR_W - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export function PullProgressOverlay({ model, proc, onCancel }) {
  const { theme } = useTheme();
  const [progress, setProgress] = useState({ phase: "resolving", percent: 0 });

  useEffect(() => {
    let buf = "";
    let errBuf = "";
    const parseLine = (line) => {
      const trimmed = line.replace(/\r/g, "").trim();
      if (!trimmed) return;
      if (/^pulling\s+\S+\s*\.?\s*$/.test(trimmed) || /^pulling\s+\S+\.\.\.\s*$/.test(trimmed)) {
        setProgress({ phase: "resolving", percent: 0, label: trimmed.replace(/^pulling\s+/, "") });
        return true;
      }
      const m = trimmed.match(/^pulling\s+(\S+):\s*\d+%.*?(\d[\d.]*\s*(?:GB|MB))\/(\d[\d.]*\s*(?:GB|MB))\s+(\S+)\s+(\S+)/);
      if (m) {
        setProgress({ phase: "pulling", percent: parseInt(trimmed.match(/(\d+)%/)[1], 10), label: `${m[1]}  ${m[2]}/${m[3]}  ${m[4]}  ${m[5]}` });
        return true;
      }
      if (/^(verifying|writing|success)/.test(trimmed)) {
        setProgress({ phase: trimmed, percent: 100 });
        return true;
      }
      return false;
    };

    const onData = (chunk, isStderr) => {
      const text = chunk.toString();
      // Modern ollama pushes all progress on stderr with \r line endings
      const combined = (isStderr ? errBuf : buf) + text;
      const lines = combined.split(/\r?\n/);
      // If the buffer ends with \r, the last "line" is actually the middle of an in-place
      // progress update — keep it in the buffer for the next chunk
      if (combined.endsWith("\r")) {
        const last = lines.pop() || "";
        if (isStderr) errBuf = last; else buf = last;
        for (const raw of lines) {
          // Each line may itself contain \r-separated in-place updates
          for (const part of raw.split("\r")) {
            if (!parseLine(part) && isStderr && /error|fail|refused|timeout|denied|not found/i.test(part)) {
              setProgress((p) => ({ ...p, phase: "error", label: part.trim().slice(0, 100) }));
            }
          }
        }
      } else {
        if (isStderr) errBuf = ""; else buf = "";
        for (const raw of lines) {
          for (const part of raw.split("\r")) {
            if (!parseLine(part) && isStderr && /error|fail|refused|timeout|denied|not found/i.test(part)) {
              setProgress((p) => ({ ...p, phase: "error", label: part.trim().slice(0, 100) }));
            }
          }
        }
      }
    };

    const onStdout = (chunk) => onData(chunk, false);
    const onStderr = (chunk) => onData(chunk, true);

    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("close", (code) => {
      if (code !== 0) setProgress({ phase: "error", percent: 0, label: `exit code ${code}` });
    });
    return () => {
      proc.stdout?.removeListener("data", onStdout);
      proc.stderr?.removeListener("data", onStderr);
    };
  }, []);

  useInput((input, key) => {
    if (key.escape) { try { proc.kill("SIGTERM"); } catch { /* proc already dead */ } onCancel(); }
  });

  const p = progress.percent || 0;

  return html`
    <Box flexDirection="column" borderStyle="round" borderColor=${theme.accent} paddingX=${2} paddingY=${1} width=${70}>
      <Box marginBottom=${1}>
        <Text color=${theme.accent} bold>Pulling ${model}</Text>
        <Text>  </Text><Text color=${theme.muted}>${progress.phase}</Text>
      </Box>
      ${progress.phase === "error" && progress.label ? html`
        <Box flexDirection="column" marginBottom=${1}>
          <Text color=${theme.error}>${progress.label.slice(0, 100)}</Text>
        </Box>` : null}
      <Box>
        <Text>${progressBar(p)} ${p}%</Text>
      </Box>
      ${progress.label && progress.phase !== "error" ? html`<Box><Text color=${theme.muted}>${progress.label.slice(0, 70)}</Text></Box>` : null}
      <Box marginTop=${1}><Text color=${theme.muted}>esc cancel</Text></Box>
    </Box>`;
}
