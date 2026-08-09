// cli/tui/app.js — the root of the interactive TUI, modeled on Claude Code: ONE persistent
// full-height frame holding a scrolling transcript (our own scrollback model, paged with
// PgUp/PgDn), a pinned input box, and themed header/footer bands. There are no full-screen
// mode swaps: system messages, guided prompts, the confirm block, and finished runs all
// append to the single transcript.
//
// Keyboard ownership is single: only the <Prompt> (when active) or the one open picker
// handles keys. The global useInput below handles ONLY Ctrl+C and Esc — never letters — so
// typing can't trigger actions. Run output never touches stdout: runSession/runGlance are
// handed an Ink reporter that writes into the live model.

import { useState, useRef, useCallback } from "react";
import { useApp, useInput, useStdout } from "ink";
import { html } from "./html.js";
import { useTermSize } from "./useTermSize.js";
import { Prompt } from "./input.js";
import { Banner, RunView } from "./runView.js";
import { Picker, PersonaAddForm, ProviderKeyForm, ConfirmDialog, ProfileCreateForm, StartingOllamaOverlay, PullProgressOverlay, OllamaInstallOverlay } from "./overlays.js";
import { makeInkReporter, newRunModel } from "./inkReporter.js";
import { COMMANDS, runSlash } from "./slash.js";
import { useTheme } from "./themeProvider.js";
import { THEME_NAMES, THEMES } from "./themes.js";

import { collectInputs, cmdDoctor } from "../commands.js";
import { runSession, runGlance } from "../session.js";
import { allPersonas, isBuiltin, removePersona } from "../personas-store.js";
import { loadAllSessions } from "../resume.js";
import { setSetting, saveConfig, loadConfig, configPath, listProfiles, activeProfileName, switchProfile as cfgSwitchProfile, createProfile as cfgCreateProfile, deleteProfile as cfgDeleteProfile } from "../config.js";
import { configDir, ensureDir } from "../paths.js";
import { looksLikeUrl, normalizeUrl } from "../args.js";
import { ALL_PROVIDERS, displayAvailable, hasKey, isLocalProvider, upsertEnvLine } from "../env.js";
import { isOllamaInstalled, isOllamaRunning, startDaemon, stopDaemon, waitForDaemon, pullModel, installOllama, listInstalledModels, removeModel, openOllamaTerminal } from "../ollama.js";
import { stripAnsi } from "../ui.js";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";

const box = (color = "gray") => ({ flexDirection: "column", borderStyle: "round", borderColor: color, paddingX: 1 });

// --- Welcome: compact header shown only when the transcript is empty and idle ---
function Welcome({ theme, cols }) {
  // The ANSI-Shadow wordmark is 75 cols wide; below that, fall back to the compact accent wordmark.
  return html`
    <Box flexDirection="column" marginBottom=${1}>
      ${cols >= 78
        ? html`<${Banner} />`
        : html`<Text bold color=${theme.accent}>⬡ scarecrow</Text>`}
      <Box flexDirection="column" marginTop=${1}>
        <Text color=${theme.fg}>Test any site like a real user. Set a URL and a goal — or just type what to test.</Text>
        <Text><Text dimColor>Try:  </Text><Text color=${theme.accent}>acme.com</Text><Text color=${theme.muted}>   ·   </Text><Text color=${theme.accent}>"sign up for a free trial"</Text><Text color=${theme.muted}>   ·   </Text><Text color=${theme.accent}>/help</Text></Text>
      </Box>
    </Box>`;
}

// --- Bar: a full-width themed band. Ink can't paint a <Box> background, so we build ONE <Text>
// whose backgroundColor covers the whole row and pad the gap between the left and right content
// with spaces. `leftLen`/`rightLen` are the plain-text widths (all our content is single-width)
// used to size that gap; if the row is too narrow to fit both, the right side is dropped so the
// line never wraps onto a second row. Every child <Text> also sets backgroundColor so no cell
// falls back to the terminal default, regardless of Ink's transform inheritance.
function Bar({ bg, width, left, leftLen, right, rightLen }) {
  const gap = width - leftLen - rightLen;
  if (gap < 1) {
    return html`<Text backgroundColor=${bg}>${left}${" ".repeat(Math.max(1, width - leftLen))}</Text>`;
  }
  return html`<Text backgroundColor=${bg}>${left}${" ".repeat(gap)}${right}</Text>`;
}

// --- StatusFooter: one-line context + hints pinned under the input, as a themed band ---
function StatusFooter({ theme, session, collecting, postRun, cols }) {
  const urlHost = session.url ? session.url.replace(/^https?:\/\//, "").split("/")[0] : null;
  const hint = collecting ? "↵ continue · esc cancel"
    : postRun ? "type a goal ↵ to start new · esc dismiss"
    : "/ commands · ↑↓ history · ↵ run · ^C ^C quit";
  const mode = session.mode || "walkthrough";
  const ctx  = ` · ${session.provider || "auto"}${session.personaKey ? ` · ${  session.personaKey}` : ""}${urlHost ? `  ${  urlHost}` : ""}`;
  const leftPlain  = ` ${mode}${ctx}`;
  const rightPlain = `${hint} `;
  const left  = html`<Text backgroundColor=${theme.surface}> <Text color=${theme.accent}>${mode}</Text><Text color=${theme.muted}>${ctx}</Text></Text>`;
  const right = html`<Text backgroundColor=${theme.surface} color=${theme.muted}>${rightPlain}</Text>`;
  // cols - 2: the footer sits inside a paddingX=1 column, so its content width is two less.
  return html`<${Bar} bg=${theme.surface} width=${cols - 2} left=${left} leftLen=${leftPlain.length} right=${right} rightLen=${rightPlain.length} />`;
}

// --- Header: slim, sticky top bar with the brand and current context, as a themed band ---
function Header({ theme, version, session, cols }) {
  const mode = session.mode || "walkthrough";
  const rightPlain = `${mode}  ·  v${version} `;
  const left  = html`<Text backgroundColor=${theme.surface}> <Text bold color=${theme.accent}>⬡ scarecrow</Text></Text>`;
  const right = html`<Text backgroundColor=${theme.surface} color=${theme.muted}>${rightPlain}</Text>`;
  return html`<${Bar} bg=${theme.surface} width=${cols} left=${left} leftLen=${" ⬡ scarecrow".length} right=${right} rightLen=${rightPlain.length} />`;
}

export function App({ ctx, initialSession }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { theme, themeName, switchTheme } = useTheme();
  const { rows, cols } = useTermSize();

  const [session, setSession] = useState(initialSession);
  const [scrollback, setScrollback] = useState([]);
  const [scrollOffset, setScrollOffset] = useState(0); // 0 = pinned to latest at the bottom
  const [, setGen] = useState(0); // bump to force a re-render (used by clear())
  const [phase, setPhase] = useState("idle");
  const [postRun, setPostRun] = useState(false);
  const [overlay, setOverlay] = useState(null);
  const [history, setHistory] = useState([]);
  // collecting: { queue: string[], idx: number, goal: string } — drives the inline guided flow
  // when a goal is submitted but url/persona/task are missing.
  const [collecting, setCollecting] = useState(null);
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  // Refs mirror state so async work and the global key handler see current values.
  const sessionRef    = useRef(session);    sessionRef.current    = session;
  const phaseRef      = useRef(phase);      phaseRef.current      = phase;
  const overlayRef    = useRef(overlay);    overlayRef.current    = overlay;
  const collectingRef = useRef(collecting); collectingRef.current = collecting;
  const scrollLenRef  = useRef(0);          scrollLenRef.current  = scrollback.length;
  const liveRef       = useRef(null);
  const cancelRef     = useRef(false);
  const abortRef      = useRef(null);
  const ctrlCArmed    = useRef(false);
  const idRef         = useRef(0);
  const id = () => ++idRef.current;

  const patchSession = (partial) => setSession((s) => ({ ...s, ...partial }));
  const pushNode = (node) => { setScrollback((s) => [...s, { id: id(), node }]); setScrollOffset(0); };
  const message  = (text, color) => pushNode(html`<Text color=${color}>${text}</Text>`);
  const error    = (text) => pushNode(html`<Text color=${theme.error}>${text}</Text>`);

  // Best-effort "open this URL in the default browser" for TUI fallback prompts. `open`
  // (the previous implementation here) only exists on macOS; branch by platform the same
  // way cli/ollama.js's openOllamaTerminal() does for spawning terminals, and report a
  // failure into the transcript (never console.error — stray stdout writes corrupt the
  // Ink-managed screen) rather than swallowing it silently.
  const openInBrowser = (url) => {
    const plat = process.platform;
    const [cmd, args] = plat === "darwin" ? ["open", [url]]
      : plat === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
    import("node:child_process").then((cp) => {
      const proc = cp.spawn(cmd, args, { stdio: "ignore", detached: true });
      proc.on("error", () => error(`couldn't open a browser automatically — visit ${url} manually`));
      proc.unref();
    }).catch(() => error(`couldn't open a browser automatically — visit ${url} manually`));
  };

  // --- Ollama pre-flight checks ---
  const ensureOllamaReady = async () => {
    // Step 1: install if missing
    if (!isOllamaInstalled()) {
      const isWin = process.platform === "win32";
      const go = await new Promise((resolve) => {
        setOverlay({
          type: "confirm",
          message: isWin
            ? "Ollama is not installed. Open the installer in a new terminal window?"
            : "Ollama is not installed. Install via official script (curl https://ollama.com/install.sh | sh)?",
          confirmLabel: "Install",
          cancelLabel: "Cancel",
          onConfirm: () => { setOverlay(null); resolve(true); },
          onCancel: () => { setOverlay(null); resolve(false); },
        });
      });
      if (!go) return;

      // The bundled installOllama() shells out to `sh -c "curl … | sh"`, which has no `sh`
      // on Windows. Route through the platform-aware terminal spawn (same one the plain-CLI
      // flow in commands.js uses) and poll for completion instead of streaming its output
      // inline — there's no piped stdout/stderr to show once it's in its own window.
      const ok = isWin
        ? await new Promise((resolve) => {
            openOllamaTerminal("install");
            let cancelled = false;
            setOverlay({
              type: "starting-ollama",
              message: "Waiting for the installer to finish…",
              onCancel: () => { cancelled = true; setOverlay(null); resolve(false); },
            });
            (async () => {
              const deadline = Date.now() + 120_000;
              while (Date.now() < deadline && !cancelled) {
                if (isOllamaInstalled()) { if (!cancelled) { setOverlay(null); resolve(true); } return; }
                await new Promise((r) => setTimeout(r, 2000));
              }
              if (!cancelled) { setOverlay(null); resolve(false); }
            })();
          })
        : await new Promise((resolve) => {
            const proc = installOllama(() => {});
            setOverlay({ type: "ollama-install", proc, onCancel: () => { try { proc.kill("SIGTERM"); } catch { /* proc already dead */ } setOverlay(null); resolve(false); } });
            proc.on("close", (code) => { setOverlay(null); resolve(code === 0); });
          });

      if (!ok || !isOllamaInstalled()) {
        await new Promise((resolve) => {
          setOverlay({
            type: "confirm",
            message: "Installation may have failed. Open the download page for manual install?",
            confirmLabel: "Open page",
            cancelLabel: "Cancel",
            onConfirm: () => { openInBrowser("https://ollama.com/download"); setOverlay(null); resolve(); },
            onCancel: () => { setOverlay(null); resolve(); },
          });
        });
        return;
      }
    }

    // Step 2: start daemon if not running
    let cancelled = false;
    while (!cancelled && !(await isOllamaRunning())) {
      const go = await new Promise((resolve) => {
        setOverlay({
          type: "confirm",
          message: "Ollama is installed but not running. Start the daemon?",
          confirmLabel: "Start",
          cancelLabel: "Cancel",
          onConfirm: () => { setOverlay(null); resolve(true); },
          onCancel: () => { setOverlay(null); resolve(false); },
        });
      });
      if (!go) { cancelled = true; break; }

      startDaemon();
      await new Promise((resolve) => {
        setOverlay({ type: "starting-ollama", onCancel: () => { cancelled = true; setOverlay(null); resolve(); } });
        waitForDaemon(15000).then((ready) => {
          if (cancelled) return;
          setOverlay(null);
          if (!ready) {
            setOverlay({
              type: "confirm",
              message: "Could not connect to Ollama. Retry?",
              confirmLabel: "Retry",
              cancelLabel: "Cancel",
              onConfirm: () => { setOverlay(null); resolve(true); },
              onCancel: () => { setOverlay(null); resolve(false); cancelled = true; },
            });
          } else {
            resolve();
          }
        });
      });
    }
    if (cancelled) return;
  };

  // --- running a session ---
  const startRun = async (goal) => {
    if (phaseRef.current === "running") return;
    const s = sessionRef.current;
    const task = (goal && goal.trim()) || s.task;
    // Defensive: if somehow called without url/task, route through the guided flow.
    if (!s.url || !task) { beginRun(goal); return; }

    // Ollama pre-flight: ensure daemon running before entering run state
    if (s.provider === "ollama") {
      if (!(await isOllamaRunning())) {
        await ensureOllamaReady();
      }
    }

    cancelRef.current = false;
    const ac = new AbortController();
    abortRef.current = ac;
    const model = newRunModel(s.mode);
    liveRef.current = model;
    setPhase("running"); phaseRef.current = "running";
    setScrollOffset(0);
    bump();
    const reporter = makeInkReporter(model, bump);
    let skipPostRun = false;
    try {
      const flags = {
        url: s.url, persona: s.personaKey, task,
        provider: s.provider, model: s.model, steps: s.steps,
        headed: s.headed && displayAvailable(), // pre-resolved so collectInputs never console.errors under Ink
        full: s.full,
        success: s.success ?? undefined,
        upload: s.upload ?? undefined,
      };
      const inputs = await collectInputs(
        s.mode === "glance" ? "glance" : "run",
        { flags, positionals: [s.url], config: ctx.config },
        { interactive: false }
      );
      const onOutOfSteps = async ({ step, totalSteps }) =>
        new Promise((resolve) => {
          setOverlay({
            type: "extend-steps", step, totalSteps,
            onExtend: (extra) => { setOverlay(null); resolve({ extraSteps: extra }); },
            onSkip: () => { setOverlay(null); resolve(null); },
          });
        });
      const run = inputs.glance ? runGlance : runSession;
      const res = await run(inputs, { reporter, shouldStop: () => cancelRef.current, abortSignal: ac.signal, onOutOfSteps });
      if (res?.cancelled) model.cancelled = true;
    } catch (e) {
      if (e?.message?.includes("rate limit exceeded after")) {
        skipPostRun = true;
        setOverlay({
          type: "rate-limit-exhausted",
          onNewSession: () => { setOverlay(null); clear(); },
          onExit: () => exit(),
        });
      } else {
        model.error = e?.message || String(e);
      }
    } finally {
      abortRef.current = null;
      const finished = liveRef.current;
      liveRef.current = null;
      setPhase("idle"); phaseRef.current = "idle";
      cancelRef.current = false;
      if (!skipPostRun) {
        pushNode(html`<${RunView} model=${finished} live=${false} />`);
        setPostRun(true);
      }
      bump();
    }
  };

  // --- inline guided collection (beginRun → collect missing fields → confirm → startRun) ---

  // Advance to the next missing field, or finish and show the confirm block.
  // patchedValues — values just set via patchSession that haven't rendered yet (avoids stale ref).
  const advance = async (col, newGoal, patchedValues) => {
    const goal    = newGoal !== undefined ? newGoal : col.goal;
    const nextIdx = col.idx + 1;
    if (nextIdx < col.queue.length) {
      setCollecting({ ...col, idx: nextIdx, goal });
    } else {
      // All fields collected — append the confirmation to the transcript. Because there are
      // no mode swaps, this box is visible with the input pinned beneath it.
      const s = { ...sessionRef.current, ...patchedValues };
      pushNode(html`
        <Box ...${box(theme.warning)}>
          <Text bold>CONFIRM YOUR SESSION</Text>
          <Text> </Text>
          <Text><Text dimColor>Goal:     </Text>${goal || s.task || "(not set)"}</Text>
          <Text><Text dimColor>URL:      </Text>${s.url || "(not set)"}</Text>
          <Text><Text dimColor>Persona:  </Text>${s.personaKey || "(not set)"}</Text>
          <Text><Text dimColor>Steps:    </Text>${s.steps}</Text>
          <Text><Text dimColor>Mode:     </Text>${s.mode}</Text>
          <Text><Text dimColor>Device:   </Text>${s.device}</Text>
          <Text> </Text>
          <Text dimColor>Press Enter to start the run, or N to go home.</Text>
        </Box>`);
      // One-shot confirm handler: next input starts the run or cancels.
      setCollecting({ queue: [], idx: 0, goal: goal || s.task, confirmMode: true });
    }
  };

  // Entry point: figure out what's missing and start collecting, or run immediately.
  const beginRun = (goal) => {
    const s    = sessionRef.current;
    const task = (goal && goal.trim()) || s.task;
    const queue = [];
    if (!task)         queue.push("task");
    if (!s.url)        queue.push("url");
    if (!s.personaKey) queue.push("persona");
    if (queue.length === 0) {
      startRun(task);
    } else {
      setCollecting({ queue, idx: 0, goal: task || "" });
    }
  };

  // Handle an answer submitted while the bar is in collecting mode.
  const handleCollectAnswer = (value) => {
    const col = collectingRef.current;
    if (!col) return;

    // Confirmation mode: any non-cancel text starts the run; /cancel or N aborts to home.
    if (col.confirmMode) {
      if (value === "/cancel" || value.toLowerCase() === "n") {
        setCollecting(null);
        clear();
        return;
      }
      setCollecting(null);
      startRun(col.goal || sessionRef.current.task);
      return;
    }

    const field = col.queue[col.idx];

    if (field === "url") {
      if (!value) { message("Please enter a URL to test.", theme.warning); return; }
      const url = normalizeUrl(value);
      patchSession({ url });
      message(`URL → ${url}`);
      advance(col, undefined, { url });
    } else if (field === "task") {
      if (!value) { message("Please describe the goal.", theme.warning); return; }
      patchSession({ task: value });
      message(`goal → ${value}`);
      advance(col, value, { task: value });
    } else if (field === "persona") {
      if (!value) {
        const all = allPersonas();
        setOverlay({
          type: "pick", title: "Choose a persona", initial: sessionRef.current.personaKey,
          items: Object.entries(all).map(([k, p]) => ({ value: k, label: k, hint: p.name })),
          onPick: (k) => {
            patchSession({ personaKey: k });
            message(`persona → ${k}`);
            setOverlay(null);
            advance(col, undefined, { personaKey: k });
          },
        });
        return;
      }
      const all = allPersonas();
      if (!all[value]) {
        message(`unknown persona "${value}" — type or use ↵ to open picker`, theme.warning);
        return;
      }
      patchSession({ personaKey: value });
      message(`persona → ${value}`);
      advance(col, undefined, { personaKey: value });
    }
  };

  const cancelCollect = () => {
    setCollecting(null);
    message("setup cancelled.", theme.warning);
  };

  // --- overlays (all render inline just above the input; the Prompt is unmounted while open) ---
  const openPersonaPicker = () => {
    const all = allPersonas();
    setOverlay({
      type: "pick", title: "Choose a persona", initial: sessionRef.current.personaKey,
      items: Object.entries(all).map(([k, p]) => ({ value: k, label: k, hint: p.name })),
      onPick: (k) => { patchSession({ personaKey: k }); setOverlay(null); message(`persona → ${all[k].name} (${k})`); },
    });
  };
  // Masked key-paste overlay: on save, write the key to .env (mode 600) and set it live in
  // process.env so the very next run picks it up. This never switches the active provider —
  // /provider only manages keys; /model (below) is where provider + model are chosen.
  const openProviderKey = (p) => setOverlay({
    type: "provider-key", provider: p,
    onSave: (key) => {
      setOverlay(null);
      try {
        // The XDG config dir, never ctx.scriptDir: for a global install that is inside
        // node_modules — typically root-owned (EACCES) and wiped on every upgrade. This
        // matches `crow init` and the onboarding wizard, and loadEnv() already reads it.
        const envPath = join(ensureDir(configDir()), ".env");
        upsertEnvLine(envPath, p.env, key);
        process.env[p.env] = key;
        message(`saved ${p.env} → ${envPath}`);
      } catch (e) { error(`couldn't save key: ${e.message}`); }
    },
    onCancel: () => setOverlay(null),
  });
  // /provider <name>: resolve a key-based provider and open its paste form directly.
  const editProviderKey = async (name) => {
    const { listProviders } = await import("../../llm.js"); // dynamic: keeps the LLM SDKs out of TUI startup
    const p = listProviders().find((x) => x.name === name);
    if (!p) return error(`unknown provider "${name}"`);
    if (p.local) return message(`${p.name} is local & keyless — no key to set; pick it in /model`);
    openProviderKey(p);
  };
  // /provider (no arg): pick which key-based provider to add/edit a key for.
  const openKeyManager = async () => {
    const { listProviders } = await import("../../llm.js");
    const provs = listProviders().filter((p) => !p.local);
    setOverlay({
      type: "pick", title: "Set or edit an API key",
      items: provs.map((p) => ({
        value: p.name, label: p.name, hint: hasKey(p.name) ? "key set · edit" : "not set · add",
      })),
      onPick: (name) => { setOverlay(null); openProviderKey(provs.find((p) => p.name === name)); },
      onCancel: () => setOverlay(null),
    });
  };
  // /model (no arg): the unified picker — every ready provider (key set, or local/keyless
  // Ollama), grouped under a header, listing its curated models. Shows install status for
  // Ollama models. Picking an uninstalled Ollama model triggers install + pull.
  const openModelPicker = async () => {
    const s = sessionRef.current;
    const { modelsFor, MODEL_SIZES } = await import("../../llm.js");

    // installedMap: name → real size string (e.g. "2.1GB") from `ollama list`
    let installedMap;
    try {
      installedMap = new Map(listInstalledModels().map((o) => [o.name, o.sizeStr]));
    } catch { installedMap = new Map(); }

    const items = [];
    for (const name of ALL_PROVIDERS) {
      if (!isLocalProvider(name) && !hasKey(name)) continue;
      items.push({ header: `${name}  · ${isLocalProvider(name) ? "local" : "key set"}` });
      modelsFor(name).forEach((m, i) => {
        const isDefault = i === 0;
        let hint;
        if (name === "ollama") {
          const realSize = installedMap.get(m);
          if (realSize) {
            hint = isDefault ? `★ default  ✓ ${realSize}` : `✓ ${realSize}`;
          } else {
            const est = MODEL_SIZES[m];
            if (isDefault) hint = `★ default  ${est || ""}`;
            else hint = `${est || ""}`;
          }
        } else {
          hint = isDefault ? "★ default" : "★";
        }
        items.push({ value: `${name}::${m}`, label: m, group: name, hint });
      });
    }
    if (!items.length) { error("no provider is configured yet — add a key with /provider, or use /model <id>"); return; }
    setOverlay({
      type: "pick", title: "Choose a model", filterable: true, items,
      initial: `${s.provider}::${s.model}`,
      onPick: async (value) => {
        const i = value.indexOf("::");
        const provider = value.slice(0, i), model = value.slice(i + 2);
        patchSession({ provider, model });
        setOverlay(null);
        message(`model → ${provider} · ${model}`);

        // Ollama: install + daemon + pull at selection time instead of on run
        if (provider === "ollama" && !installedMap.has(model)) {
          // Step 1+2: ensure Ollama is installed and daemon is running
          await ensureOllamaReady();
          // Step 3: pull the model
          const go = await new Promise((resolve) => {
            setOverlay({
              type: "confirm",
              message: `Model "${model}" is not pulled. Pull it now?`,
              confirmLabel: "Pull",
              cancelLabel: "Cancel",
              onConfirm: () => { setOverlay(null); resolve(true); },
              onCancel: () => { setOverlay(null); resolve(false); },
            });
          });
          if (!go) return;

          await new Promise((resolve) => {
            const proc = pullModel(model, () => {});
            setOverlay({ type: "pull-progress", model, proc, onCancel: () => { try { proc.kill("SIGTERM"); } catch { /* proc already dead */ } setOverlay(null); resolve(); } });
            proc.on("close", (code) => {
              setOverlay(null);
              if (code !== 0) error(`Failed to pull model "${model}"`);
              resolve();
            });
          });
        }
      },
      onCancel: () => setOverlay(null),
    });
  };
  const openModelRemove = () => {
    const installed = listInstalledModels();
    if (!installed.length) { message("no Ollama models installed.", theme.warning); return; }
    setOverlay({
      type: "pick", title: "Remove an Ollama model",
      items: installed.map((o) => ({ value: o.name, label: `${o.name}  ${o.sizeStr}` })),
      onPick: (model) => {
        setOverlay(null);
        setOverlay({
          type: "confirm",
          message: `Remove Ollama model "${model}"?`,
          confirmLabel: "Remove",
          cancelLabel: "Cancel",
          onConfirm: () => {
            setOverlay(null);
            try { removeModel(model); message(`removed Ollama model "${model}"`); }
            catch (e) { error(`failed to remove: ${e.message}`); }
          },
          onCancel: () => setOverlay(null),
        });
      },
      onCancel: () => setOverlay(null),
    });
  };
  const openPersonaRemove = () => {
    const custom = Object.entries(allPersonas()).filter(([k]) => !isBuiltin(k));
    if (!custom.length) { message("no custom personas to remove.", theme.warning); return; }
    setOverlay({
      type: "pick", title: "Remove a custom persona",
      items: custom.map(([k, p]) => ({ value: k, label: k, hint: p.name })),
      onPick: (k) => {
        try { removePersona(k); message(`removed persona "${k}"`); if (sessionRef.current.personaKey === k) patchSession({ personaKey: undefined }); }
        catch (e) { error(e.message); }
        setOverlay(null);
      },
    });
  };
  const openPersonaAdd = () => setOverlay({ type: "persona-add" });
  const openRerunPicker = () => {
    const sessions = loadAllSessions("runs", 15);
    if (!sessions.length) { message("no past sessions found in runs/.", theme.warning); return; }
    setOverlay({
      type: "pick", title: "Rerun a session",
      items: sessions.map((s) => ({
        value: s.id, label: s.id,
        hint: `${s.persona} · ${s.task.length > 28 ? `${s.task.slice(0, 26)}..` : s.task}`,
      })),
      onPick: (rid) => {
        const chosen = sessions.find((x) => x.id === rid);
        setOverlay(null);
        const inp = chosen?.state?.inputs || {};
        const patch = {};
        if (inp.url)                   patch.url = inp.url;
        if (inp.personaKey)            patch.personaKey = inp.personaKey;
        if (inp.task)                  patch.task = inp.task;
        if (Number.isInteger(inp.steps)) patch.steps = inp.steps;
        if (inp.provider)              patch.provider = inp.provider;
        if (inp.model)                 patch.model = inp.model;
        if (inp.device)                patch.device = inp.device;
        if (inp.full != null)          patch.full = inp.full;
        if (inp.success)               patch.success = inp.success;
        if (Object.keys(patch).length === 0) { message(`session "${rid}" has no re-runnable inputs saved.`, theme.warning); return; }
        clear();
        patchSession(patch);
        message(`loaded ${rid}${inp.task ? ` — "${inp.task}"` : ""}. Press ↵ to run.`);
      },
    });
  };

  // --- informational commands (append to the transcript) ---
  const listPersonas = () => {
    const all = allPersonas();
    pushNode(html`
      <Box ...${box(theme.border)}>
        <Text bold>personas</Text>
        ${Object.entries(all).map(([k, p]) => html`<Text key=${k}>  <Text bold>${k.padEnd(12)}</Text>${p.name}${isBuiltin(k) ? "" : html`<Text dimColor>  · custom</Text>`}</Text>`)}
      </Box>`);
  };
  const listProviders = () => {
    // dynamic import: keeps LLM SDKs out of TUI startup
    import("../../llm.js").then(({ listProviders: lp, modelsFor }) => {
      const provs = lp();
      pushNode(html`
        <Box ...${box(theme.border)}>
          <Text bold>providers</Text>
          ${provs.map((p) => {
            const status = p.local ? "local" : hasKey(p.name) ? "key set" : "no key";
            const modelHint = modelsFor(p.name)[0] || "";
            return html`<Text key=${p.name}>  <Text bold>${p.name.padEnd(12)}</Text><Text dimColor>${status}</Text>${modelHint ? html`<Text dimColor> · </Text><Text>${modelHint}</Text>` : ""}</Text>`;
          })}
        </Box>`);
    }).catch(() => {});
  };
  const showConfig = () => {
    const s = sessionRef.current;
    const profile = activeProfileName();
    pushNode(html`
      <Box ...${box(theme.border)}>
        <Text bold>session</Text>
        <Text><Text dimColor>profile:  </Text>${profile}</Text>
        <Text><Text dimColor>mode:     </Text>${s.mode}</Text>
        <Text><Text dimColor>persona:  </Text>${s.personaKey || "(unset)"}</Text>
        <Text><Text dimColor>url:      </Text>${s.url || "(unset)"}</Text>
        <Text><Text dimColor>goal:     </Text>${s.task || "(typed each run)"}</Text>
        <Text><Text dimColor>steps:    </Text>${s.steps}</Text>
        <Text><Text dimColor>provider: </Text>${s.provider || "auto"}${s.model ? ` · ${  s.model}` : ""}</Text>
        <Text><Text dimColor>browser:  </Text>${s.headed ? "headed" : "headless"}</Text>
        <Text><Text dimColor>full page:</Text> ${s.full ? "on" : "off"}</Text>
        ${s.success ? html`<Text><Text dimColor>success:  </Text>"${s.success}"</Text>` : null}
        ${s.upload ? html`<Text><Text dimColor>uploads:  </Text>${s.upload === true ? "uploads/ folder" : s.upload}</Text>` : null}
        <Text dimColor>defaults file: ${configPath()}</Text>
      </Box>`);
  };
  const saveDefaults = () => {
    const s = sessionRef.current;
    const toSave = { provider: s.provider, model: s.model, persona: s.personaKey, steps: s.steps, headed: s.headed, full: s.full, device: s.device };
    const done = [];
    try {
      for (const [k, v] of Object.entries(toSave)) if (v !== undefined && v !== null) { setSetting(k, String(v)); done.push(k); }
      saveConfig();
      message(`saved defaults (profile: ${activeProfileName()}): ${done.join(", ")}`);
    } catch (e) { error(e.message); }
  };
  const doctor = async () => {
    const lines = [];
    const ol = console.log, oe = console.error;
    console.log = (...a) => lines.push(stripAnsi(a.map(String).join(" ")));
    console.error = (...a) => lines.push(stripAnsi(a.map(String).join(" ")));
    try { await cmdDoctor(ctx); }
    catch (e) { lines.push(`doctor error: ${  e?.message || e}`); }
    finally { console.log = ol; console.error = oe; }
    pushNode(html`<Box ...${box(theme.border)}>${lines.filter((l) => l !== "").map((l, i) => html`<Text key=${i}>${l}</Text>`)}</Box>`);
  };
  const help = () => {
    pushNode(html`
      <Box ...${box(theme.border)}>
        <Text bold>commands</Text>
        ${COMMANDS.filter((c) => c.name !== "exit").map((c) => html`<Text key=${c.name}>  <Text color=${theme.accent}>/${c.name}</Text>${c.args ? ` ${  c.args}` : ""}  <Text dimColor>${c.summary}</Text></Text>`)}
        <Text> </Text>
        <Text bold>keys</Text>
        <Text>  <Text color=${theme.accent}>Shift+Tab</Text>  <Text dimColor>cycle mode (walkthrough / glance)</Text></Text>
        <Text>  <Text color=${theme.accent}>Tab</Text>        <Text dimColor>autocomplete a / command</Text></Text>
        <Text>  <Text color=${theme.accent}>↑ / ↓</Text>      <Text dimColor>command list, or input history</Text></Text>
        <Text>  <Text color=${theme.accent}>Ctrl+A / E</Text>  <Text dimColor>jump to start / end of the line</Text></Text>
        <Text>  <Text color=${theme.accent}>Ctrl+← / →</Text>  <Text dimColor>jump by word (also Alt/Option+←/→)</Text></Text>
        <Text>  <Text color=${theme.accent}>Esc</Text>        <Text dimColor>clear / cancel / stop a run</Text></Text>
        <Text>  <Text color=${theme.accent}>Ctrl+C</Text>     <Text dimColor>stop a run, or exit</Text></Text>
      </Box>`);
  };
  const clear = () => {
    if (stdout) stdout.write("\x1b[2J\x1b[3J\x1b[H");
    setGen((g) => g + 1);
    setScrollback([]);
  };
  const quit = () => { stopDaemon(); exit(); };

  const openProfilePicker = () => {
    const profiles = listProfiles();
    const entries = Object.entries(profiles);
    if (!entries.length) { message("no profiles available."); return; }
    const current = activeProfileName();
    setOverlay({
      type: "pick", title: "Switch profile", initial: current,
      items: entries.map(([k, p]) => ({ value: k, label: k, hint: p.description || "" })),
      onPick: (name) => {
        setOverlay(null);
        try {
          cfgSwitchProfile(name);
          const cfg = loadConfig();
          clear();
          patchSession({ provider: cfg.provider, model: cfg.model, persona: cfg.persona, steps: cfg.steps, headed: cfg.headed, full: cfg.full, device: cfg.device, theme: cfg.theme, exportFormat: cfg.exportFormat });
          message(`switched to profile "${name}"`);
        } catch (e) { error(e.message); }
      },
    });
  };
  const switchProfile = (name) => {
    cfgSwitchProfile(name);
    const cfg = loadConfig();
    clear();
    patchSession({ provider: cfg.provider, model: cfg.model, persona: cfg.persona, steps: cfg.steps, headed: cfg.headed, full: cfg.full, device: cfg.device, theme: cfg.theme, exportFormat: cfg.exportFormat });
    message(`switched to profile "${name}"`);
  };
  const createProfile = (name) => {
    const s = sessionRef.current;
    const settings = { provider: s.provider, model: s.model, persona: s.personaKey, steps: s.steps, headed: s.headed, full: s.full, device: s.device, theme: s.theme, exportFormat: s.exportFormat, upload: s.upload, success: s.success };
    setOverlay({
      type: "profile-create", profileName: name, settings,
      onSave: () => {
        setOverlay(null);
        try {
          cfgCreateProfile(name, settings);
          message(`created profile "${name}"`);
        } catch (e) { error(e.message); }
      },
      onCancel: () => setOverlay(null),
    });
  };
  const deleteProfile = (name) => {
    cfgDeleteProfile(name);
    message(`deleted profile "${name}"`);
  };
  const openProfileDelete = () => {
    const profiles = listProfiles();
    const nonDefault = Object.entries(profiles).filter(([k]) => k !== "default");
    if (!nonDefault.length) { message("no profiles to delete (default cannot be deleted).", theme.warning); return; }
    setOverlay({
      type: "pick", title: "Delete a profile",
      items: nonDefault.map(([k, p]) => ({ value: k, label: k, hint: p.description || "" })),
      onPick: (name) => {
        setOverlay(null);
        setOverlay({
          type: "confirm",
          message: `Delete profile "${name}"?`,
          confirmLabel: "Yes, delete it",
          cancelLabel: "No, keep it",
          onConfirm: () => {
            setOverlay(null);
            try { cfgDeleteProfile(name); message(`deleted profile "${name}"`); }
            catch (e) { error(e.message); }
          },
          onCancel: () => setOverlay(null),
        });
      },
    });
  };

  const cycleMode = () => {
    // Silent: just flip the mode. The Header + StatusFooter show it, so no transcript line.
    const m = sessionRef.current.mode === "walkthrough" ? "glance" : "walkthrough";
    patchSession({ mode: m });
  };

  // Generic one-off picker for slash commands (/device, /export-format): closes the
  // overlay, then applies the choice. Esc simply closes it — same as every other picker.
  const choose = ({ title, items, initial, onPick }) =>
    setOverlay({ type: "pick", title, items, initial, onPick: (v) => { setOverlay(null); onPick(v); } });

  const api = {
    get session() { return sessionRef.current; },
    setSession: patchSession, message, error, choose,
    startRun, openPersonaPicker, openPersonaAdd, openPersonaRemove, openKeyManager, editProviderKey, openModelPicker, openModelRemove, openRerunPicker,
    listPersonas, listProviders, showConfig, saveDefaults, doctor, help, clear, quit,
    setTheme: (t) => { switchTheme(t); try { setSetting("theme", t); } catch { /* non-fatal */ } message(`theme → ${t}`); },
    openLogsBrowser: () => {
      // Logs are scoped per-run (cli/logger.js writes into the run directory when one is
      // set, or configDir()/logs otherwise) — never cwd, which is unpredictable for a
      // globally installed CLI. This browses the fallback location; per-run logs live
      // alongside that run's other artifacts (see /resume for the run directory).
      const logsDir = join(configDir(), "logs");
      let files;
      try {
        files = readdirSync(logsDir).filter((f) => f.endsWith(".log")).sort().reverse().slice(0, 20);
      } catch { files = []; }
      if (!files.length) { message(`no logs found in ${logsDir} — run a session first.`, theme.warning); return; }
      setOverlay({
        type: "pick", title: "Session logs", filterable: true,
        items: files.map((f) => ({ value: f, label: f, hint: "" })),
        onPick: (f) => {
          setOverlay(null);
          try {
            const content = readFileSync(join(logsDir, f), "utf-8");
            const lines = content.trim().split("\n").slice(-50);
            pushNode(html`
              <Box ...${box(theme.border)} flexDirection="column">
                <Text bold>${f}</Text>
                <Text> </Text>
                ${lines.map((l, i) => html`<Text key=${i} dimColor>${l}</Text>`)}
              </Box>`);
          } catch (e) { error(`couldn't read log: ${e.message}`); }
        },
        onCancel: () => setOverlay(null),
      });
    },
    openThemePicker: () => {
      const original = themeName; // restore this if the user cancels the preview
      setOverlay({
        type: "pick", title: "Choose a theme", initial: themeName,
        items: THEME_NAMES.map((k) => ({ value: k, label: k, hint: THEMES[k].blurb })),
        onHighlight: (k) => switchTheme(k), // live preview as the selection moves
        onPick: (k) => { switchTheme(k); try { setSetting("theme", k); } catch { /* non-fatal */ } setOverlay(null); message(`theme → ${k}`); },
        onCancel: () => { switchTheme(original); setOverlay(null); },
      });
    },
    openProfilePicker,
    switchProfile,
    createProfile,
    deleteProfile,
    openProfileDelete,
  };

  const onSubmit = (text) => {
    // After a run finishes, empty submit dismisses; commands/URLs act normally;
    // a goal shows a confirmation to start a new session or go home.
    if (postRun) {
      if (!text) { setPostRun(false); return; }
      if (text.startsWith("/")) { setPostRun(false); runSlash(api, text); return; }
      if (looksLikeUrl(text)) {
        setPostRun(false);
        const u = /^https?:\/\//i.test(text) ? text : `https://${  text}`;
        patchSession({ url: u });
        message(`url → ${u}${  sessionRef.current.task ? "" : ". Now type the goal."}`);
        return;
      }
      // Goal text — show confirmation to start new session or go home.
      setOverlay({
        type: "new-session", goal: text,
        onStart: () => { setOverlay(null); setPostRun(false); clear(); beginRun(text); },
        onHome: () => { setOverlay(null); setPostRun(false); clear(); },
      });
      return;
    }

    // During collecting, route to the field handler rather than the normal flow.
    if (collectingRef.current) { handleCollectAnswer(text); return; }

    if (!text) {
      const s = sessionRef.current;
      if (s.url && s.task) { clear(); startRun(s.task); }
      return;
    }
    setHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));
    if (text.startsWith("/")) { runSlash(api, text); return; }
    if (looksLikeUrl(text)) {
      const u = /^https?:\/\//i.test(text) ? text : `https://${  text}`;
      patchSession({ url: u });
      message(`url → ${u}${  sessionRef.current.task ? "" : ". Now type the goal."}`);
      return;
    }
    // Goal submitted: collect whatever's missing, then confirm + run.
    beginRun(text);
  };

  // Global keys — ONLY Ctrl+C and Esc, never letters (so typing can't trigger actions).
  // Ctrl+C: cancel run → close overlay → cancel collect → confirm-then-exit.
  // Esc: confirm cancel dialog, or (when no overlay is open) cancel a collecting session.
  const requestCancel = () => {
    if (cancelRef.current) return;
    cancelRef.current = true;
    abortRef.current?.abort();
    message("stopping after this step…", theme.warning);
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (phaseRef.current === "running") { requestCancel(); return; }
      if (overlayRef.current) { const oc = overlayRef.current.onCancel; if (oc) oc(); else setOverlay(null); return; }
      if (collectingRef.current) { cancelCollect(); return; }
      if (ctrlCArmed.current) { exit(); return; }
      ctrlCArmed.current = true;
      message("Press Ctrl+C again to exit.", theme.warning);
      setTimeout(() => { ctrlCArmed.current = false; }, 1500);
      return;
    }
    // History scroll through the transcript viewport (0 = pinned to the latest at bottom).
    if (!overlayRef.current) {
      if (key.pageUp)   { setScrollOffset((o) => Math.min(o + 1, Math.max(0, scrollLenRef.current - 1))); return; }
      if (key.pageDown) { setScrollOffset((o) => Math.max(o - 1, 0)); return; }
    }
    if (postRun && key.escape) { setPostRun(false); return; }
    if (phaseRef.current === "running" && key.escape) {
      if (!overlayRef.current) {
        setOverlay({
          type: "confirm-cancel",
          onConfirm: () => { setOverlay(null); requestCancel(); },
          onCancel: () => setOverlay(null),
        });
      }
      return;
    }
    if (collectingRef.current && !overlayRef.current && key.escape) cancelCollect();
  });

  const renderOverlay = () => {
    if (overlay.type === "pick")
      return html`<${Picker} title=${overlay.title} items=${overlay.items} initial=${overlay.initial} filterable=${!!overlay.filterable} onPick=${overlay.onPick} onHighlight=${overlay.onHighlight} onCancel=${overlay.onCancel || (() => setOverlay(null))} />`;
    if (overlay.type === "persona-add")
      return html`<${PersonaAddForm} onSave=${(r) => { setOverlay(null); message(`added persona "${r.key}" (${r.name}) — select it with /persona ${r.key}`); }} onCancel=${() => setOverlay(null)} />`;
    if (overlay.type === "provider-key")
      return html`<${ProviderKeyForm} provider=${overlay.provider} onSave=${overlay.onSave} onCancel=${overlay.onCancel} />`;
    if (overlay.type === "confirm-cancel")
      return html`<${ConfirmDialog} message="Cancel the current run?" confirmLabel="Yes, stop it" cancelLabel="No, continue" onConfirm=${overlay.onConfirm} onCancel=${overlay.onCancel} />`;
    if (overlay.type === "extend-steps")
      return html`<${ConfirmDialog} message="Step ${overlay.step}/${overlay.totalSteps}: ran out of steps. Add 5 more?" confirmLabel="Add 5 steps" cancelLabel="No, finish" onConfirm=${() => overlay.onExtend(5)} onCancel=${overlay.onSkip} />`;
    if (overlay.type === "new-session")
      return html`<${ConfirmDialog} message=${`Start a new session with "${overlay.goal.slice(0, 60)}"?`} confirmLabel="Start new session" cancelLabel="Go to home" onConfirm=${overlay.onStart} onCancel=${overlay.onHome} />`;
    if (overlay.type === "profile-create")
      return html`<${ProfileCreateForm} profileName=${overlay.profileName} settings=${overlay.settings} onSave=${overlay.onSave} onCancel=${overlay.onCancel} />`;
    if (overlay.type === "confirm")
      return html`<${ConfirmDialog} message=${overlay.message} confirmLabel=${overlay.confirmLabel} cancelLabel=${overlay.cancelLabel} onConfirm=${overlay.onConfirm} onCancel=${overlay.onCancel} />`;
    if (overlay.type === "ollama-install")
      return html`<${OllamaInstallOverlay} proc=${overlay.proc} onCancel=${overlay.onCancel} />`;
    if (overlay.type === "starting-ollama")
      return html`<${StartingOllamaOverlay} onCancel=${overlay.onCancel} message=${overlay.message} />`;
    if (overlay.type === "pull-progress")
      return html`<${PullProgressOverlay} model=${overlay.model} proc=${overlay.proc} onCancel=${overlay.onCancel} />`;
    if (overlay.type === "rate-limit-exhausted")
      return html`<${ConfirmDialog} message="Provider rate limit was exceeded. Start a new session or exit." confirmLabel="Start new session" cancelLabel="Exit" onConfirm=${overlay.onNewSession} onCancel=${overlay.onExit} />`;
    return null;
  };

  // The field currently being collected ("url" | "persona" | "task" | undefined)
  const collectingField = collecting?.confirmMode ? "__confirm__" : collecting?.queue[collecting.idx];

  const isRunning   = phase === "running";
  const isOverlay   = !!overlay;
  const showWelcome = scrollback.length === 0 && !isRunning && !isOverlay && !collecting;
  // Transcript items currently visible: hide the last `scrollOffset` (PgUp scrolls back).
  const visible     = scrollback.slice(0, Math.max(0, scrollback.length - scrollOffset));
  const centerMid   = showWelcome || isOverlay;

  // ── Fixed fullscreen frame: sticky Header · scrolling viewport · sticky search bar ──
  // Fill the whole terminal so Ink consistently uses its full-screen clear (\x1b[2J) path
  // every frame; hovering just under `rows` makes it oscillate between clear and
  // incremental erase, which leaves ghost cells.
  return html`
    <Box flexDirection="column" width=${cols} height=${rows}>
      <${Header} theme=${theme} version=${ctx.version || "0.0.0"} session=${session} cols=${cols} />

      <Box flexGrow=${1} flexDirection="column" overflow="hidden" paddingX=${1}
           justifyContent=${centerMid ? "center" : "flex-end"}
           alignItems=${centerMid ? "center" : "stretch"}>

        ${showWelcome ? html`<${Welcome} theme=${theme} cols=${cols} />` : null}

        ${isOverlay ? renderOverlay() : null}

        ${!centerMid ? html`
          <Box flexDirection="column">
            ${visible.map((item) => html`<Box key=${item.id} flexDirection="column" marginBottom=${1}>${item.node}</Box>`)}
            ${isRunning ? html`
              <Box flexDirection="column">
                <${RunView} model=${liveRef.current} live=${true} />
                <Box marginTop=${1}><Text dimColor>running… </Text><Text color=${theme.warning}>Esc</Text><Text dimColor> to stop</Text></Box>
              </Box>` : null}
            ${scrollOffset > 0 ? html`<Box><Text dimColor>▲ ${scrollOffset} newer below · PgDn to catch up</Text></Box>` : null}
          </Box>` : null}
      </Box>

      <Box flexShrink=${0} flexDirection="column" paddingX=${1}>
        ${collecting ? html`
          <Box marginBottom=${1}><Text dimColor>goal: </Text><Text>${collecting.goal || "(none)"}</Text></Box>` : null}
        <${Prompt} key=${collectingField || "prompt"} active=${!isRunning && !isOverlay} onSubmit=${onSubmit} onShiftTab=${cycleMode} history=${history} collecting=${collectingField} postRun=${postRun} loadedGoal=${session.task || ""} />
        <${StatusFooter} theme=${theme} session=${session} collecting=${!!collecting} postRun=${postRun} cols=${cols} />
      </Box>
    </Box>`;
}
