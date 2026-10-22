// cli/commands.js — everything that isn't the run loop itself: gathering inputs
// (with prompts for whatever's missing), the guided wizard, and the helper commands
// (personas, doctor, init, config).
//
// Heavy modules (playwright, the LLM SDKs) are imported lazily inside the functions
// that need them, so `personas` / `config` / `help` / `version` start instantly.

import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join, resolve, sep, dirname } from "node:path";
import { allPersonas, isBuiltin } from "./personas-store.js";
import {
  PROVIDER_ENV, presentKeys, detectProvider, hasKey, isLocalProvider, displayAvailable, upsertEnvLine,
} from "./env.js";
import {
  loadConfig, configPath, SETTINGS, setSetting, unsetSetting, resetConfig, pick,
} from "./config.js";
import { configDir, ensureDir } from "./paths.js";
import { isUnsupportedNode } from "./node-check.js";
import { c, sym, panel, select, text, confirm, password, isInteractive, UserError } from "./ui.js";
import { suggest, normalizeUrl, assertSafeTarget } from "./args.js";
import { redact } from "./logger.js";
import { banner } from "./render.js";
import { isOllamaInstalled, isOllamaRunning, isModelInstalled, startDaemon, waitForDaemon, pullModel, openOllamaTerminal } from "./ollama.js";
import { comingSoon } from "./coming-soon.js";
import { parseSuccess, runPassed } from "./success.js";
import { MAX_STEPS } from "./limits.js";

// Upper bound for --steps (cli/limits.js); refuse rather than silently clamp.
export { MAX_STEPS };

// --- uploads resolution (moved from index.js) -------------------------------
// Where `--upload` looks. Mirrors loadEnv()'s precedence: a project-local ./uploads wins
// (the documented workflow — drop files next to your project, which is what `init`
// creates), otherwise the XDG config dir for when you're running from somewhere without
// one. Never the install directory: a global install lives somewhere like
// /usr/local/lib/node_modules, which is typically root-owned and wiped on upgrade.
export function resolveUploadsDir() {
  const local = join(process.cwd(), "uploads");
  return existsSync(local) ? local : join(configDir(), "uploads");
}

function uploadsFolderFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith(".") && n.toLowerCase() !== "readme.md")
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isFile());
}

function resolveUploads(flag, uploadsDir, quiet = false) {
  if (flag === true) return uploadsFolderFiles(uploadsDir); // bare --upload = whole folder
  if (typeof flag !== "string" || !flag.trim()) return [];
  const isFile = (p) => existsSync(p) && statSync(p).isFile();
  const normalizedUploads = resolve(uploadsDir);
  // resolve() only collapses ".."/"." lexically; it doesn't follow symlinks. Precompute the
  // real (symlink-resolved) uploads root once so a symlink placed inside uploads/ that
  // points elsewhere on disk can be caught below, not just a lexical "../".
  let realUploads;
  try { realUploads = realpathSync(normalizedUploads); } catch { realUploads = normalizedUploads; }
  const out = [];
  for (const raw of flag.split(",").map((s) => s.trim()).filter(Boolean)) {
    // Only allow files inside the uploads/ directory to prevent path traversal
    const uploadsPath = join(uploadsDir, raw);
    const resolved = resolve(uploadsPath);
    if (!resolved.startsWith(`${normalizedUploads}${sep}`) && resolved !== normalizedUploads) {
      if (!quiet) console.error(c.yellow(`upload file must be inside uploads/ directory: ${raw}`));
      continue;
    }
    if (!isFile(resolved)) {
      if (!quiet) console.error(c.yellow(`upload file not found: ${raw}`));
      continue;
    }
    let real;
    try { real = realpathSync(resolved); } catch { continue; }
    if (real !== realUploads && !real.startsWith(`${realUploads}${sep}`)) {
      if (!quiet) console.error(c.yellow(`upload file resolves outside uploads/ directory: ${raw}`));
      continue;
    }
    out.push(resolved);
  }
  return out;
}

// --- model resolution -------------------------------------------------------
// A model id belongs to one provider. MODEL (env) and a saved `model` are only applied when
// they were set alongside the provider actually in use — otherwise `--provider gemini` with
// a saved Claude model would send "claude-…" to Gemini. An explicit --model always wins.
export function effectiveModel(provider, { flagModel, cfg = {}, defaultModel }) {
  const env = process.env;
  const fromEnv = env.MODEL && (!env.PROVIDER || env.PROVIDER === provider) ? env.MODEL : null;
  const fromCfg = cfg.model && (!cfg.provider || cfg.provider === provider) ? cfg.model : null;
  return pick(flagModel, fromEnv, fromCfg, null) || defaultModel;
}

// --- input collection -------------------------------------------------------
// Resolves every field a run needs, prompting for missing ones when interactive and
// throwing a clear UserError otherwise. Precedence is flag > env > saved config > default.
export async function collectInputs(mode, { flags, positionals, config }, { interactive }) {
  const cfg = config || loadConfig();
  const uploadsDir = resolveUploadsDir();

  // Gated features (cli/coming-soon.js): say so up front instead of silently half-working.
  for (const name of ["record", "a11y"]) {
    if (flags[name] && !flags.json) console.error(c.yellow(`${sym.warn} ${comingSoon(name)} Ignoring --${name}.`));
  }
  const { providerInfo } = await import("../llm.js");

  // provider + model
  const provider = pick(flags.provider, process.env.PROVIDER, cfg.provider, null) || detectProvider() || "anthropic";
  let info;
  try { info = providerInfo(provider); } catch (e) { throw new UserError(e.message); }
  const model = effectiveModel(provider, { flagModel: flags.model, cfg, defaultModel: info.defaultModel });

  // url
  let url = flags.url || positionals[0];
  if (!url) {
    if (interactive) url = await text("URL to test", { validate: (v) => (v ? null : "Please enter a URL.") });
    else throw new UserError('No URL given. Pass it first, e.g. `crow example.com`, or run `crow` for guided mode.');
  }
  url = normalizeUrl(String(url).trim());
  try { assertSafeTarget(url); } catch (e) { throw new UserError(e.message); }

  // persona
  const personas = allPersonas();
  let personaKey = flags.persona || cfg.persona;
  if (personaKey && !personas[personaKey])
    throw new UserError(`Unknown persona "${personaKey}". Choose: ${Object.keys(personas).join(", ")}.`);
  if (!personaKey) {
    if (interactive) {
      personaKey = await select(
        "Persona",
        Object.entries(personas).map(([k, p]) => ({ value: k, label: k, hint: p.name })),
        { default: cfg.persona }
      );
    } else {
      throw new UserError(`No persona given. Use --persona=<key> (one of: ${Object.keys(personas).join(", ")}).`);
    }
  }

  // goal
  let task = flags.task;
  if (!task) {
    if (interactive) task = await text("What is this user trying to do? (their goal)", { validate: (v) => (v ? null : "Describe the goal in a few words.") });
    else throw new UserError('No goal given. Use --task="...".');
  }
  task = String(task).trim();

  // Validate rather than coerce. `Math.max(1, Number(x) || 8)` silently turned `-n 0` into
  // the full default of 8 (Number(0) is falsy) — the opposite of what was asked, at 9x the
  // cost — and accepted `-n 99999` without comment. Roughly one vision call per step, so
  // an unbounded value is real money.
  const rawSteps = pick(flags.steps, undefined, cfg.steps, 8);
  const steps = Number(rawSteps);
  if (!Number.isInteger(steps) || steps < 1)
    throw new UserError(`--steps expects a positive whole number (got "${rawSteps}").`);
  if (steps > MAX_STEPS)
    throw new UserError(`--steps is capped at ${MAX_STEPS} (got ${steps}) — each step costs roughly one vision API call.`);
  const full = pick(flags.full, undefined, cfg.full, false);

  // Headed (visible browser) is the default; fall back to headless when there's no
  // display, so servers/CI keep working without anyone passing --no-headed.
  let headed = pick(flags.headed, undefined, cfg.headed, true);
  if (headed && !displayAvailable()) {
    headed = false;
    if (!flags.json) console.error(c.dim("(no display detected — running headless; use a desktop to watch it live)"));
  }

  // key check, with an actionable message (local providers like Ollama need no key)
  if (!isLocalProvider(provider) && !hasKey(provider)) {
    const p = providerInfo(provider);
    throw new UserError(
      `${p.env} is not set (needed for provider "${p.name}").\n` +
      `Get a key at ${p.signupUrl}, then either:\n` +
      `  • export ${p.env}=...\n` +
      `  • run \`crow init\` to create a .env\n` +
      `  • add it to a .env file in this folder`
    );
  }

  // Device viewport preset
  const device = pick(flags.device, undefined, cfg.device, "desktop");


  return {
    url,
    personaKey,
    persona: personas[personaKey],
    task,
    steps,
    glance: mode === "glance",
    full: !!full,
    success: validSuccess(flags.success),
    headed: !!headed,
    device,
    record: false, // coming soon — see cli/coming-soon.js
    a11y: false,   // coming soon — see cli/coming-soon.js
    ci: !!flags.ci,
    quiet: !!flags.quiet || !!flags.json,
    json: !!flags.json,
    // Carried into the reporter so mid-run prompts (e.g. "add more steps?") know to
    // skip themselves rather than throw on a terminal that can't answer.
    yes: !!flags.yes,
    out: typeof flags.out === "string" ? flags.out : null,
    upload: resolveUploads(flags.upload, uploadsDir, !!flags.quiet || !!flags.json),
    logResponses: flags["log-responses"] !== false,
    cfg: { provider, model },
  };
}

// --success: validated up front so a typo'd regex fails before the browser launches.
function validSuccess(spec) {
  if (typeof spec !== "string") return null;
  try { parseSuccess(spec); } catch (e) { throw new UserError(e.message); }
  return spec.trim();
}

function printRunSummary(inputs) {
  console.log(
    `\n${ 
    panel("READY", [
      `${c.dim("mode:    ")} ${inputs.glance ? "glance" : "session"}`,
      `${c.dim("url:     ")} ${inputs.url}`,
      `${c.dim("persona: ")} ${inputs.persona.name} ${c.dim(`(${  inputs.personaKey  })`)}`,
      `${c.dim("goal:    ")} ${inputs.task}`,
      ...(inputs.glance ? [] : [`${c.dim("steps:   ")} ${inputs.steps}`]),
      `${c.dim("model:   ")} ${inputs.cfg.provider} ${c.dim(sym.dot)} ${inputs.cfg.model}`,
      ...(inputs.headed ? [`${c.dim("browser: ")} headed (visible)`] : []),
      ...(inputs.upload.length ? [`${c.dim("uploads: ")} ${inputs.upload.length} file(s) ready`] : []),
    ])}`
  );
}

// Ollama pre-flight for the plain CLI: install, start and pull as needed. Every decline or
// failure throws a UserError, so the run stops here instead of launching a browser against
// a model that can't answer.
async function ensureOllamaReadyCli(provider, model) {
  if (provider !== "ollama") return;

  // Daemon cleanup on exit/crash is registered centrally by startDaemon() (cli/cleanup.js);
  // nothing to wire up here.

  // Step 1: install if missing
  if (!isOllamaInstalled()) {
    if (!isInteractive()) {
      throw new UserError(`Ollama is not installed. Install it from https://ollama.com/download, then run \`ollama serve\` and \`ollama pull ${model}\`.`);
    }
    const ok = await confirm("Ollama is not installed. Install it now?", true);
    if (!ok) throw new UserError("Ollama is required for --provider ollama. Install it from https://ollama.com/download.");

    openOllamaTerminal("install");
    console.error(c.dim("⏳ Installation running in a new terminal. Waiting for it to complete..."));
    const deadline = Date.now() + 120_000;
    let installed = false;
    while (Date.now() < deadline) {
      await sleep(5000);
      if (isOllamaInstalled()) { installed = true; break; }
      process.stderr.write(".");
    }
    console.error("");
    if (!installed) throw new UserError("Timed out waiting for the Ollama installation. Install it manually from https://ollama.com/download.");
    console.error(c.dim("Ollama installed."));
  }

  // Step 2: start daemon if not running
  if (!(await isOllamaRunning())) {
    if (isInteractive()) {
      const ok = await confirm("Ollama is installed but not running. Start the daemon?", true);
      if (!ok) throw new UserError("Ollama isn't running. Start it with `ollama serve`, then run again.");
    }

    console.error(c.dim("Starting Ollama server..."));
    startDaemon();
    const ready = await waitForDaemon(15000);
    if (ready) {
      console.error(c.dim("Ollama is ready."));
    } else {
      throw new UserError("Could not connect to Ollama. Make sure `ollama serve` is running.");
    }
  }

  // Step 3: pull model if missing
  if (!(await isModelInstalled(model))) {
    if (isInteractive()) {
      const ok = await confirm(`Model "${model}" is not pulled. Pull it now?`, true);
      if (!ok) throw new UserError(`Model "${model}" isn't pulled. Run \`ollama pull ${model}\`, then run again.`);
    }

    console.error(c.dim(`Pulling model "${model}" — this may take a while...`));
    await new Promise((resolve, reject) => {
      const proc = pullModel(model, (p) => {
        if (p.phase === "pulling" && p.percent !== undefined) {
          process.stderr.write(`\r${c.dim(`  ${p.percent}% · ${p.speed || ""} · ${p.eta || ""}`)}`);
        }
      });
      proc.on("close", (code) => {
        process.stderr.write("\n");
        if (code === 0) { console.error(c.dim(`Model "${model}" pulled.`)); resolve(); }
        else reject(new UserError(`Failed to pull model "${model}". Try \`ollama pull ${model}\` yourself to see why.`));
      });
    });
  }
}

// `batch`: called from cmdBatch, which owns the exit code for the whole batch — a single
// run must not set it, or the last run's result would overwrite the others'.
export async function runFlow(mode, parsed, ctx, { interactive, confirmRun = false, batch = false }) {
  const inputs = await collectInputs(
    mode,
    { flags: parsed.flags, positionals: parsed.positionals, config: ctx.config },
    { interactive }
  );

  if (confirmRun && !parsed.flags.yes) {
    printRunSummary(inputs);
    if (!(await confirm("Start the run?", true))) {
      console.log(c.dim("Aborted."));
      return { aborted: true };
    }
  }

  // Ollama pre-flight: ensure daemon running + model pulled
  await ensureOllamaReadyCli(inputs.cfg.provider, inputs.cfg.model);

  // Browser pre-flight: lazy install if missing (uses confirm prompts — needs cooked stdin)
  const { ensureBrowser } = await import("./browser-setup.js");
  await ensureBrowser();

  const { runSession, runGlance } = await import("./session.js");
  const result = inputs.glance
    ? await runGlance(inputs, { version: ctx.version })
    : await runSession(inputs, { version: ctx.version });

  // Pass/fail (cli/success.js runPassed): an objective --success check decides task
  // completion when given; any high-severity finding fails. A cancelled run has no verdict.
  const cancelled = !!(result?.cancelled || result?.aborted);
  const passed = cancelled ? null
    : runPassed({ findings: result?.findings, assertion: result?.assertion, glance: inputs.glance });
  if (inputs.ci && !batch) {
    if (cancelled) {
      console.error(c.dim("\n--ci: run was cancelled, skipping pass/fail evaluation"));
    } else {
      process.exitCode = passed ? 0 : 1;
      const decidedBy = result?.assertion ? `objective check ${result.assertion.passed ? "passed" : "failed"}` : `task: ${result?.findings?.wouldCompleteTask ?? "unknown"}`;
      console.error(c.dim(`\n--ci: exiting ${passed ? 0 : 1} (${decidedBy})`));
    }
  }
  return { ...result, passed };
}

export const cmdRun = (parsed, ctx) =>
  runFlow(parsed.flags.glance ? "glance" : "run", parsed, ctx, {
    interactive: isInteractive(),
    confirmRun: isInteractive() && !parsed.flags.yes,
  });

export const cmdGlance = (parsed, ctx) =>
  runFlow("glance", parsed, ctx, {
    interactive: isInteractive(),
    confirmRun: isInteractive() && !parsed.flags.yes,
  });

// --- batch mode --------------------------------------------------------------
export async function cmdBatch(parsed, ctx) {
  const batchFile = parsed.flags.batch;
  if (!batchFile) throw new UserError("Usage: crow --batch <file.json>");

  let runs;
  try {
    const content = readFileSync(batchFile, "utf8");
    runs = JSON.parse(content);
  } catch (e) {
    throw new UserError(`Failed to read batch file: ${e.message}`);
  }

  if (!Array.isArray(runs) || runs.length === 0) {
    throw new UserError("Batch file must be a non-empty JSON array of run configurations");
  }

  // ── validate batch entries ───────────────────────────────────────────────────
  // url/persona/task may come from the entry or from CLI-level flags (which act as
  // defaults for every entry). Unknown fields warn and are ignored; only genuinely
  // missing requirements block the batch.
  const KNOWN_BATCH_FIELDS = ["url", "persona", "task", "steps", "device", "headed"];
  const errors = [];
  const warnings = [];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const tag = `run #${i + 1}`;

    if (!run || typeof run !== "object" || Array.isArray(run)) {
      errors.push(`${tag}: expected a JSON object, got ${run === null ? "null" : Array.isArray(run) ? "an array" : typeof run}`);
      continue;
    }

    for (const key of Object.keys(run)) {
      if (!KNOWN_BATCH_FIELDS.includes(key)) {
        const near = suggest(key, KNOWN_BATCH_FIELDS);
        warnings.push(`${tag}: ignoring unknown field "${key}"${near ? ` — did you mean "${near}"?` : ""}`);
      }
    }

    if (!run.url && !parsed.flags.url && !parsed.positionals[0]) errors.push(`${tag}: needs a "url"`);
    if (!run.task && !parsed.flags.task) errors.push(`${tag}: needs a "task"`);
    if (!run.persona && !parsed.flags.persona) errors.push(`${tag}: needs a "persona" (see \`crow personas\`)`);
  }

  if (warnings.length) {
    console.error();
    for (const w of warnings) console.error(`  ${c.yellow(sym.warn)} ${w}`);
  }
  if (errors.length) {
    console.error(`\n${c.bold("BATCH VALIDATION")}\n`);
    for (const e of errors) console.error(`  ${c.red(sym.err)} ${e}`);
    console.error(`\n${c.dim("Each entry needs url, persona, and task (inherited from CLI flags if set there):")}`);
    console.error(c.dim(`  { "url": "https://example.com", "persona": "novice", "task": "find pricing",`));
    console.error(c.dim(`    "steps": 6, "device": "mobile", "headed": true }`));
    console.error();
    throw new UserError(`Batch file has ${errors.length} validation error(s) — fix and retry`);
  }

  console.log(`\n${c.bold("BATCH MODE")} — ${runs.length} run(s) queued\n`);

  const results = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    console.log(`${c.cyan(`\n[${i + 1}/${runs.length}]`)  } ${run.url || "(no url)"} — ${run.task || "(no task)"}`);

    try {
      // Entry fields override CLI flags only when actually present, so CLI-level
      // --persona/--task/etc. serve as batch-wide defaults.
      const overrides = Object.fromEntries(
        KNOWN_BATCH_FIELDS.map((k) => [k, run[k]]).filter(([, v]) => v !== undefined)
      );
      const batchParsed = {
        ...parsed,
        flags: { ...parsed.flags, ...overrides },
        positionals: run.url ? [run.url] : parsed.positionals,
      };
      const result = await runFlow("run", batchParsed, ctx, { interactive: false, batch: true });
      results.push({ ...run, result, success: true, passed: result?.passed });
    } catch (e) {
      console.error(c.red(`  Failed: ${redact(e.message)}`));
      results.push({ ...run, error: e.message, success: false });
    }
  }

  // Summary
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;
  console.log(`\n${c.bold("BATCH COMPLETE")}: ${c.green(`${succeeded} succeeded`)} · ${c.red(`${failed} failed`)}`);

  if (parsed.flags.ci) {
    // Fails if ANY run errored or failed its pass/fail check, not just the last one.
    const failing = results.filter((r) => !r.success || r.passed === false).length;
    process.exitCode = failing > 0 ? 1 : 0;
    console.error(c.dim(`\n--ci: ${failing} of ${results.length} run(s) failed — exiting ${failing > 0 ? 1 : 0}`));
  }

  return results;
}

// --- guided interactive wizard ----------------------------------------------
export async function runWizard(parsed, ctx) {
  if (!isInteractive())
    throw new UserError('Interactive mode needs a terminal. Try `crow <url> -p <persona> -t "goal"`, or `crow --help`.');

  console.log(`\n${  banner(ctx.version)}`);
  console.log(c.dim("Guided setup — answer a few prompts, or pass flags next time to skip this.\n"));

  let mode = parsed.flags.glance ? "glance" : null;
  if (!mode) {
    mode = await select(
      "What do you want to do?",
      [
        { value: "run", label: "Run a full click-through", hint: "the persona acts step by step" },
        { value: "glance", label: "Quick first-impression glance", hint: "one screenshot critique" },
      ],
      { default: "run" }
    );
  }

  // Only ask which provider when more than one key is available and none is pinned.
  const keys = presentKeys();
  if (!parsed.flags.provider && !process.env.PROVIDER && keys.length > 1) {
    const { providerInfo } = await import("../llm.js");
    const prov = await select(
      "Which provider?",
      keys.map((k) => ({ value: k, label: k, hint: providerInfo(k).defaultModel })),
      { default: ctx.config.provider || keys[0] }
    );
    parsed = { ...parsed, flags: { ...parsed.flags, provider: prov } };
  }

  return runFlow(mode, parsed, ctx, { interactive: true, confirmRun: true });
}

// --- personas ---------------------------------------------------------------
export function cmdPersonas(parsed) {
  const personas = allPersonas();
  const key = parsed.positionals[0];
  if (key) {
    const p = personas[key];
    if (!p) throw new UserError(`Unknown persona "${key}". Choose: ${Object.keys(personas).join(", ")}.`);
    console.log(`\n${c.bold(p.name)} ${c.dim(`(${  key  })`)}${isBuiltin(key) ? "" : c.dim(" · custom")}\n`);
    console.log(`${p.description.trim()  }\n`);
    return;
  }
  console.log(`\n${  c.bold("PERSONAS")  }\n`);
  for (const [k, p] of Object.entries(personas))
    console.log(`  ${c.bold(k.padEnd(9))}${p.name}${isBuiltin(k) ? "" : c.dim("  · custom")}`);
  console.log(`\n${  c.dim("Show one in detail:  crow personas <key>")}`);
}

// --- doctor -----------------------------------------------------------------
export async function cmdDoctor(ctx) {
  const checks = [];
  const add = (level, label, detail = "") => checks.push({ level, label, detail });

  // Checked against package.json's engines range, same as the guard in index.js — a
  // hardcoded floor here would drift from the manifest the moment engines changes.
  const supportedNode = ctx.engines?.node;
  const badNode = isUnsupportedNode(supportedNode);
  add(badNode ? "err" : "ok", `Node ${process.versions.node}`, badNode ? `needs Node ${supportedNode}` : "");

  // Browser presence — read-only (no launch): resolve the path and stat it.
  try {
    const { chromium } = await import("playwright");
    const exe = chromium.executablePath();
    const ok = !!exe && existsSync(exe);
    add(ok ? "ok" : "err", "Playwright Chromium", ok ? exe : "not installed → npx playwright install chromium");
  } catch {
    add("err", "Playwright Chromium", "not installed → npx playwright install chromium");
  }

  if (ctx.envFiles.length) {
    // A .env holds API keys — warn if group/other can read it (mode & 0o077).
    let loose = "";
    try {
      const mode = statSync(ctx.envFiles[0]).mode & 0o777;
      if (process.platform !== "win32" && (mode & 0o077)) loose = `  (mode ${mode.toString(8)} — run: chmod 600 ${ctx.envFiles[0]})`;
    } catch { /* ignore */ }
    add(loose ? "warn" : "ok", ".env file", ctx.envFiles.join(", ") + loose);
  } else {
    add("warn", ".env file", "none found → run `crow init`");
  }

  for (const [prov, env] of Object.entries(PROVIDER_ENV)) {
    const set = !!process.env[env];
    add(set ? "ok" : "warn", `${prov} key`, set ? `${env} is set` : `${env} not set`);
  }

  const keys = presentKeys();
  const { providerInfo } = await import("../llm.js");
  const provider = process.env.PROVIDER || ctx.config.provider || detectProvider() || "anthropic";
  let model = "?";
  try { model = effectiveModel(provider, { cfg: ctx.config, defaultModel: providerInfo(provider).defaultModel }); } catch { /* unknown provider */ }
  // Local providers (Ollama) need no API key; key-based providers require a key to be present.
  const ready = isLocalProvider(provider) || keys.length > 0;
  const note = isLocalProvider(provider) ? "  (local — ensure `ollama serve` is running)" : ready ? "" : "  (no key set!)";
  add(ready ? "ok" : "err", "Effective model", `${provider} ${sym.dot} ${model}${note}`);

  add("ok", "Display", displayAvailable()
    ? `${process.env.WAYLAND_DISPLAY || process.env.DISPLAY || "available"  } — runs open a window (--no-headed to hide)`
    : "none — runs are headless");

  const uploadsDir = resolveUploadsDir();
  add("ok", "Uploads folder", existsSync(uploadsDir) ? uploadsDir : "none → run `crow init` to create ./uploads");
  add("ok", "Config file", existsSync(configPath()) ? configPath() : "none (using defaults)");

  console.log(`\n${  banner(ctx.version)  }\n`);
  const mark = { ok: c.green(sym.ok), warn: c.yellow(sym.warn), err: c.red(sym.err) };
  for (const ch of checks) console.log(`  ${mark[ch.level]} ${c.bold(ch.label.padEnd(20))} ${c.dim(ch.detail)}`);

  const hardFail = checks.some((ch) => ch.level === "err");
  console.log(`\n${  hardFail ? c.red("Some checks failed — see the hints above.") : c.green("All set — you're ready to run.")}`);
  process.exitCode = hardFail ? 1 : 0;
}

// --- init -------------------------------------------------------------------
const DEFAULT_ENV = [
  "# Scarecrow — provider keys. Set the one you want; it's auto-detected.",
  "ANTHROPIC_API_KEY=",
  "# GEMINI_API_KEY=",
  "# GROQ_API_KEY=",
  "# Ollama is local & keyless: `ollama serve` + `ollama pull qwen3-vl`, then --provider ollama",
  "",
  "# Optional overrides",
  "# PROVIDER=anthropic   # anthropic | gemini | groq | ollama",
  "# MODEL=",
  "",
].join("\n");

// Seeded into a freshly created uploads/ folder. The repo's own uploads/README.md says
// the same thing, but that file isn't in package.json's `files` list — so an installed
// user would otherwise never see any of this. Same reason DEFAULT_ENV exists above.
const UPLOADS_README = [
  "# uploads/",
  "",
  "Drop the files you want a persona to upload **right here**, then reference them by",
  "**bare filename**. For safety, `--upload` only accepts files inside this folder —",
  "absolute paths and paths outside `uploads/` are rejected.",
  "",
  "```bash",
  "# attach uploads/id.png",
  'crow example.com --persona=novice --task="upload my ID" --upload=id.png',
  "",
  "# attach several from this folder",
  'crow example.com --task="import data" --upload=a.csv,b.csv',
  "",
  "# attach EVERYTHING in this folder",
  'crow example.com --task="upload my documents" --upload',
  "```",
  "",
  "Notes:",
  "- This folder is found because it sits in the directory you run `crow` from. Without",
  "  one here, `--upload` falls back to the uploads folder in your config directory.",
  "- A `multiple` upload field receives all the files you pass; a single-file field takes",
  "  the first and ignores the rest (logged in the report).",
  "- Files only attach to upload dialogs opened by the agent's own click — a hidden file",
  "  input sprung by the page itself is cancelled.",
  "- This `README.md` and any dotfiles are ignored by `--upload` (the all-files form), so",
  "  they're never attached.",
  "- Test files may hold PII or credentials — keep them out of version control.",
  "",
].join("\n");

export async function cmdInit(parsed, ctx) {
  console.log(`\n${  banner(ctx.version)  }\n`);
  // Scaffold into the XDG config directory, never the install directory: a globally
  // installed package lives somewhere like /usr/local/lib/node_modules (often root-owned,
  // and wiped on upgrade), so writing there fails or silently loses the key. Matches where
  // onboarding.js writes and where loadEnv() already looks. `.env.example` still comes from
  // the package (it ships as the template); DEFAULT_ENV covers the case where it doesn't.
  const envDir = ensureDir(configDir());
  const envPath = join(envDir, ".env");
  const examplePath = join(ctx.scriptDir, ".env.example");

  if (existsSync(envPath) && !parsed.flags.force) {
    console.log(`${c.yellow(sym.warn)} .env already exists  ${c.dim(envPath)}`);
    console.log(c.dim("   Use --force to overwrite, or just edit it."));
  } else {
    let template = DEFAULT_ENV;
    try { template = readFileSync(examplePath, "utf8"); } catch { /* fall back to default */ }
    writeFileSync(envPath, template, { mode: 0o600 }); // it will hold an API key
    try { chmodSync(envPath, 0o600); } catch { /* best effort */ }
    console.log(`${c.green(sym.ok)} Wrote ${c.dim(envPath)} ${c.dim("(mode 600)")}`);
  }

  // Uploads go in the *current* directory, unlike .env above. Upload fixtures are project
  // assets — you want them next to the site you're testing, and every doc example says
  // `cp test.pdf uploads/` — whereas an API key has no business being written into
  // whatever directory you happened to run `init` from. resolveUploadsDir() still prefers
  // this folder for --upload, so creating it here is what makes that precedence useful.
  const uploadsDir = join(process.cwd(), "uploads");
  if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true });
    console.log(`${c.green(sym.ok)} Created ${c.dim(uploadsDir)}`);
  }
  // Carries the usage notes an installed user can't get from the repo's uploads/README.md.
  const uploadsReadme = join(uploadsDir, "README.md");
  if (!existsSync(uploadsReadme)) writeFileSync(uploadsReadme, UPLOADS_README);

  if (isInteractive() && (await confirm("Add an API key now?", false))) {
    const { providerInfo } = await import("../llm.js");
    const prov = await select(
      "Which provider?",
      Object.keys(PROVIDER_ENV).map((k) => ({ value: k, label: k, hint: providerInfo(k).env })),
      { default: "anthropic" }
    );
    const env = PROVIDER_ENV[prov];
    const key = await password(`Paste your ${env} ${c.dim("(input hidden; stored in .env)")}`);
    if (key) {
      upsertEnvLine(envPath, env, key);
      console.log(`${c.green(sym.ok)} Saved ${env} to .env`);
    }
  }

  console.log("\nNext:");
  console.log(`  ${  c.dim(`verify setup ${  sym.arrow  } `)  }crow doctor`);
  console.log(`  ${  c.dim(`first run    ${  sym.arrow  } `)  }crow example.com -p skeptic -t "sign up"`);
}

// --- config -----------------------------------------------------------------
function printConfig() {
  const cfg = loadConfig();
  console.log(`\n${  c.bold("SETTINGS")  }  ${  c.dim(configPath())  }\n`);
  for (const [key, spec] of Object.entries(SETTINGS)) {
    const raw = Object.hasOwn(cfg, key) ? String(cfg[key]) : "(unset)";
    const shown = Object.hasOwn(cfg, key) ? c.cyan(raw) : c.dim(raw);
    console.log(`  ${c.bold(key.padEnd(9))} ${shown}${" ".repeat(Math.max(1, 12 - raw.length))}${c.dim(spec.desc)}`);
  }
  console.log(`\n${  c.dim("Set one:  crow config set <key> <value>")}`);
}

export function cmdConfig(parsed) {
  const [action, key, ...rest] = parsed.positionals;

  if (!action || action === "list") return printConfig();
  if (action === "path") return void console.log(configPath());
  if (action === "reset") {
    const ok = resetConfig();
    return void console.log(ok ? `${c.green(sym.ok)} Reset config (${configPath()})` : c.dim("No config file to reset."));
  }
  if (action === "get") {
    if (!key) throw new UserError("Usage: crow config get <key>");
    if (!Object.hasOwn(SETTINGS, key)) throw new UserError(`Unknown setting "${key}". See \`crow config\`.`);
    const cfg = loadConfig();
    return void console.log(Object.hasOwn(cfg, key) ? String(cfg[key]) : c.dim("(unset)"));
  }
  if (action === "set") {
    if (!key || rest.length === 0) throw new UserError("Usage: crow config set <key> <value>");
    try {
      const val = setSetting(key, rest.join(" "));
      return void console.log(`${c.green(sym.ok)} ${key} = ${val}`);
    } catch (e) { throw new UserError(e.message); }
  }
  if (action === "unset") {
    if (!key) throw new UserError("Usage: crow config unset <key>");
    try {
      const had = unsetSetting(key);
      return void console.log(had ? `${c.green(sym.ok)} unset ${key}` : c.dim(`${key} was not set`));
    } catch (e) { throw new UserError(e.message); }
  }
  throw new UserError(`Unknown config action "${action}". Try: get, set, unset, path, reset, or no argument to list.`);
}

// --- diff command ----------------------------------------------------------
export async function cmdDiff(parsed) {
  const { findRuns, generateDiffReport } = await import("./diff.js");

  // List all runs
  if (parsed.flags.list) {
    const runs = findRuns();
    if (runs.length === 0) {
      console.log(c.dim("No runs found in the runs directory."));
      return;
    }
    console.log(c.bold("Available runs:\n"));
    for (const run of runs) {
      console.log(`  ${c.cyan(run.name)}`);
      console.log(`    ${c.dim("URL:")} ${run.url}`);
      console.log(`    ${c.dim("Persona:")} ${run.persona}`);
      console.log(`    ${c.dim("Goal:")} ${run.goal}`);
      console.log(`    ${c.dim("Outcome:")} ${run.outcome}`);
      console.log(`    ${c.dim("Findings:")} ${run.findingsCount}`);
      console.log();
    }
    console.log(c.dim("To compare: crow diff --run1 <dir1> --run2 <dir2>"));
    return;
  }

  // Compare two runs
  const run1 = parsed.flags.run1 || parsed.positionals[0];
  const run2 = parsed.flags.run2 || parsed.positionals[1];

  if (!run1 || !run2) {
    throw new UserError("Usage: crow diff --run1 <dir1> --run2 <dir2> | --list");
  }

  if (!existsSync(run1)) {
    throw new UserError(`Run directory not found: ${run1}`);
  }
  if (!existsSync(run2)) {
    throw new UserError(`Run directory not found: ${run2}`);
  }

  const report = generateDiffReport(run1, run2);
  console.log(report);
}

// --- resume command --------------------------------------------------------
// Gated (cli/coming-soon.js): a real resume needs the browser state the run had, which
// isn't saved. Past runs can be re-run with the same inputs from the interactive UI (/rerun).
export function cmdResume() {
  console.log(`${c.yellow(sym.warn)} ${comingSoon("resume")}`);
  console.log(c.dim("To re-run a past session with the same inputs, start `crow` and use /rerun."));
}

// --- export command --------------------------------------------------------
export async function cmdExport(parsed) {
  const { saveExport, FORMATS } = await import("./export.js");

  const format = parsed.flags.format || "html";
  const inputPath = parsed.flags.input || parsed.positionals[0];

  if (!inputPath) {
    throw new UserError("Usage: crow export <findings.json> --format html|junit|json");
  }
  if (!FORMATS.includes(format)) {
    throw new UserError(`Unknown export format "${format}". Choose: ${FORMATS.join(", ")}.`);
  }

  const resolved = resolve(inputPath);
  if (!existsSync(resolved)) {
    throw new UserError(`File not found: ${resolved}`);
  }

  const outDir = parsed.flags.out || dirname(resolved);
  const outPath = saveExport(resolved, format, outDir);

  console.log(`${c.green("✓")} Exported to ${outPath}`);
}
