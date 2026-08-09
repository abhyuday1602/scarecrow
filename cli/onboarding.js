// cli/onboarding.js — first-run wizard.
//
// Runs when `crow` is launched with no arguments on an unconfigured system.
// Walks through: welcome → browser install → provider setup → default persona → save.
// Uses the simple prompt widgets from cli/ui.js (no Ink/React needed — this is a
// one-shot flow that exits before the TUI mounts).

import { join } from "node:path";
import { c, select, confirm, password } from "./ui.js";
import { banner } from "./render.js";
import { isBrowserInstalled, installBrowser } from "./browser-setup.js";
import { PROVIDER_ENV, presentKeys, upsertEnvLine } from "./env.js";
import { allPersonas } from "./personas-store.js";
import { setSetting } from "./config.js";
import { configDir, ensureDir } from "./paths.js";
import { redact } from "./logger.js";
import {
  isOllamaInstalled, isOllamaRunning, isModelInstalled,
  startDaemon, waitForDaemon, pullModel,
} from "./ollama.js";

// ── helpers ─────────────────────────────────────────────────────────────────

function providerLabel(name) {
  const labels = {
    anthropic: "Anthropic (Claude)",
    gemini: "Gemini (Google)",
    groq: "Groq",
    ollama: "Ollama (local — no key)",
  };
  return labels[name] || name;
}

function providerHint(name) {
  const hints = {
    anthropic: "best quality, paid",
    gemini: "free tier available",
    groq: "fast, free tier",
    ollama: "free, runs on your machine",
  };
  return hints[name] || "";
}

// ── browser step ────────────────────────────────────────────────────────────

async function stepBrowser() {
  if (await isBrowserInstalled()) return;

  console.log(`\n${c.bold("Browser")}`);
  console.log(c.dim("Scarecrow uses a headless Chromium browser to visit websites and take screenshots.\n"));

  const ok = await confirm("Install Chromium now? (~150 MB)", true);
  if (!ok) {
    console.log(c.yellow("Skipped — you'll need to install it later. Run `npx playwright install chromium` when you're ready.\n"));
    return;
  }

  console.log();
  try {
    await installBrowser();
    console.log(c.green("\n✓ Chromium installed.\n"));
  } catch (e) {
    console.error(c.red(`\nInstallation failed: ${redact(e.message)}`));
    console.error(c.dim("You can install it later with: npx playwright install chromium\n"));
  }
}

// ── provider step ───────────────────────────────────────────────────────────

async function stepProvider() {
  const keys = presentKeys();
  if (keys.length > 0 || await isOllamaInstalled()) return;

  console.log(`\n${c.bold("AI Provider")}`);
  console.log(c.dim("Scarecrow needs an AI model to power the persona. Pick a provider to get started.\n"));

  const choices = [
    { value: "anthropic", label: providerLabel("anthropic"), hint: providerHint("anthropic") },
    { value: "gemini", label: providerLabel("gemini"), hint: providerHint("gemini") },
    { value: "groq", label: providerLabel("groq"), hint: providerHint("groq") },
    { value: "ollama", label: providerLabel("ollama"), hint: providerHint("ollama") },
    { value: "", label: "(skip — set up later)", hint: "" },
  ];

  const provider = await select("Which provider?", choices);
  if (!provider) {
    console.log(c.yellow("Skipped — you can set up a provider later with the /provider command.\n"));
    return;
  }

  if (provider === "ollama") {
    await setupOllama();
  } else {
    await setupKeyedProvider(provider);
  }
}

async function setupKeyedProvider(provider) {
  const env = PROVIDER_ENV[provider];
  if (!env) {
    console.error(c.red(`Unknown provider: ${provider}`));
    return;
  }

  const { providerInfo } = await import("../llm.js");
  const info = providerInfo(provider);

  console.log(c.dim(`\nGet a free API key at ${info.signupUrl}, then paste it below.`));
  console.log(c.dim("The key is stored in .env and never printed.\n"));

  const key = await password(`Paste your ${env}`);
  if (!key) {
    console.log(c.yellow("Skipped. You can add a key later with /provider.\n"));
    return;
  }

  // Write to the XDG config directory, not cwd — avoids accidentally dropping
  // an API key into an arbitrary project directory or git repo.
  const envDir = configDir();
  ensureDir(envDir);
  const envPath = join(envDir, ".env");
  upsertEnvLine(envPath, env, key);
  console.log(c.green(`\n✓ Saved to ${envPath}\n`));

  // Set provider default in config
  try { setSetting("provider", provider); } catch { /* non-critical */ }
  try { setSetting("model", info.defaultModel); } catch { /* non-critical */ }
  console.log(c.dim(`Default model set to ${info.defaultModel}. You can change this anytime.\n`));
}

async function setupOllama() {
  if (!isOllamaInstalled()) {
    console.log(c.yellow("\nOllama isn't installed on your machine yet."));
    console.log(c.dim("Download it from https://ollama.com/download, install it, then run `ollama serve`."));
    console.log(c.dim("After that, Scarecrow's /model command can set everything up for you.\n"));
    try { setSetting("provider", "ollama"); } catch { /* non-critical */ }
    console.log(c.dim("Saved Ollama as your default provider for now.\n"));
    return;
  }

  // Start daemon if not running
  if (!(await isOllamaRunning())) {
    console.log(c.dim("Starting Ollama daemon…"));
    startDaemon();
    const ready = await waitForDaemon(15000);
    if (!ready) {
      console.log(c.yellow("Couldn't start Ollama. Make sure `ollama serve` is running.\n"));
      try { setSetting("provider", "ollama"); } catch { /* non-critical */ }
      return;
    }
    console.log(c.green("✓ Ollama is ready.\n"));
  }

  // Pick a model
  const suggested = [
    { value: "qwen3-vl", label: "qwen3-vl", hint: "~8.5 GB — recommended" },
    { value: "llama3.2-vision", label: "llama3.2-vision", hint: "~7.9 GB" },
    { value: "moondream", label: "moondream", hint: "~1.7 GB — lightweight" },
    { value: "gemma3", label: "gemma3", hint: "~2.3 GB" },
  ];

  const model = await select("Pick a vision model to pull", suggested, { default: "qwen3-vl" });

  if (await isModelInstalled(model)) {
    console.log(c.green(`✓ Model "${model}" is already installed.\n`));
  } else {
    console.log(c.dim(`\nPulling "${model}" — this may take a while depending on your connection.\n`));
    try {
      await new Promise((resolve, reject) => {
        const proc = pullModel(model, (p) => {
          if (p.phase === "pulling" && p.percent !== undefined) {
            process.stderr.write(`\r${c.dim(`  ${p.percent}% · ${p.speed || ""} · ${p.eta || ""}`)}`);
          }
        });
        proc.on("close", (code) => {
          process.stderr.write("\n");
          if (code === 0) resolve();
          else reject(new Error(`exit code ${code}`));
        });
        proc.on("error", reject);
      });
      console.log(c.green(`✓ Model "${model}" pulled.\n`));
    } catch (e) {
      console.log(c.yellow(`Pull failed: ${redact(e.message)}. You can try again later with /model.\n`));
    }
  }

  try { setSetting("provider", "ollama"); } catch { /* non-critical */ }
  try { setSetting("model", model); } catch { /* non-critical */ }
}

// ── persona step ────────────────────────────────────────────────────────────

async function stepPersona() {
  const personas = allPersonas();
  const choices = Object.entries(personas).map(([k, p]) => ({
    value: k,
    label: `${k} — ${p.name}`,
  }));
  choices.unshift({ value: "", label: "(skip — pick later)", hint: "" });

  const selected = await select("Default persona", choices, { default: "" });
  if (!selected) {
    console.log(c.dim("No default set. You can pick one each time you run.\n"));
    return;
  }

  try { setSetting("persona", selected); } catch { /* non-critical */ }
  console.log(c.green(`✓ Default persona set to "${selected}".\n`));
}

// ── main entry point ────────────────────────────────────────────────────────

export async function runOnboarding(ctx) {
  console.log(`\n${banner(ctx.version)}`);
  console.log(c.dim("Welcome! Let's get you set up.\n"));

  // Quick health check — skip completed steps
  const hasBrowser = await isBrowserInstalled();
  const hasProvider = presentKeys().length > 0 || await isOllamaInstalled();

  if (hasBrowser && hasProvider) {
    // Nothing to do — user is already configured
    console.log(c.green("Everything looks ready.\n"));
    console.log(c.dim("Your settings are saved to ~/.config/scarecrow/."));
    console.log(c.dim("Don't worry about that — just use crow and everything will be ready.\n"));
    return;
  }

  if (!hasBrowser) await stepBrowser();
  if (!hasProvider) await stepProvider();

  // Persona is optional — always offer
  console.log(c.bold("Default Persona"));
  console.log(c.dim(`A persona is the "user type" Scarecrow pretends to be. You can change it anytime.\n`));
  await stepPersona();

  // Summary
  console.log(c.green("✓ You're all set!\n"));
  console.log(c.dim("Your settings are saved to ~/.config/scarecrow/."));
  console.log(c.dim("Don't worry about that — just run crow and everything will be ready.\n"));
  console.log(c.dim("Launching Scarecrow…\n"));
}
