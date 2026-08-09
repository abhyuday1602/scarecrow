// cli/env.js — .env loading and provider/key detection.
//
// The loader is the original tiny no-dependency one: read cwd/.env first, then the
// .env next to the installed script, so a globally-installed `crow` keeps using the
// project's key while a project-local .env can still override it (cwd wins; existing
// process.env keys are never clobbered).

import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./paths.js";

// Provider → the env var that holds its API key. Order here is the auto-detect order.
// Key-based providers ONLY — this drives ENV_ALLOW (below), presentKeys/detectProvider/
// hasKey, and the .env writer. Ollama is keyless, so it is deliberately absent here.
export const PROVIDER_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
};

// Every provider the CLI supports, key-based or not. Kept SDK-free (llm.js owns the rich
// metadata — baseURL/defaultModel/signupUrl) so config/help/args validation and the TUI's
// provider hints stay cheap. Must list the same names as llm.js PROVIDERS.
export const ALL_PROVIDERS = ["anthropic", "gemini", "groq", "ollama"];
// Local providers need no API key and run against a daemon on this machine.
export const LOCAL_PROVIDERS = new Set(["ollama"]);
export const isLocalProvider = (p) => LOCAL_PROVIDERS.has(p);

// Only these may be set from a .env file. A .env is loaded from the *current*
// directory (which may be untrusted), so we refuse to let it inject arbitrary
// process env — e.g. HTTPS_PROXY (would route your API traffic + key through an
// attacker), NODE_OPTIONS, XDG_CONFIG_HOME, or DISPLAY. Only the vars Scarecrow
// itself reads are honored; everything else in the file is ignored.
const ENV_ALLOW = new Set([...Object.values(PROVIDER_ENV), "PROVIDER", "MODEL"]);

export function loadEnv(scriptDir) {
  const seen = new Set();
  const loaded = [];
  for (const path of [join(process.cwd(), ".env"), join(scriptDir, ".env"), join(configDir(), ".env")]) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    loaded.push(path);
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (!m || !ENV_ALLOW.has(m[1]) || process.env[m[1]]) continue;
      let val = m[2];
      // Strip surrounding quotes (single or double) as a matched pair
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      // Strip inline comments only on unquoted values (quoted values may contain #)
      else val = val.replace(/\s+#.*$/, "");
      process.env[m[1]] = val;
    }
  }
  return loaded; // paths actually read (handy for `doctor`)
}

// Which provider keys are currently set (never returns the values themselves).
export const presentKeys = () =>
  Object.entries(PROVIDER_ENV).filter(([, env]) => !!process.env[env]).map(([p]) => p);

// First provider with a key present, or null if none are.
export const detectProvider = () => presentKeys()[0] ?? null;

export const hasKey = (provider) => !!process.env[PROVIDER_ENV[provider]];

// Is there a GUI display we could open a headed browser on? macOS/Windows always
// have one; on Linux we need an X or Wayland display. Used so "headed by default"
// degrades to headless on servers/CI instead of crashing.
export const displayAvailable = () =>
  process.platform === "darwin" ||
  process.platform === "win32" ||
  !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

// Write (or replace) a `KEY=value` line in a .env file, creating the file if missing.
// The .env holds a secret, so it's written mode 600. Any commented-out `# KEY=` line is
// replaced in place. CR/LF is stripped from the value so a pasted key can't inject extra
// lines. Used by `crow init` and the TUI's /provider key-paste flow.
export function upsertEnvLine(path, key, value) {
  let content = "";
  try { content = readFileSync(path, "utf8"); } catch { /* new file */ }
  const line = `${key}=${String(value).replace(/[\r\n]+/g, "")}`;
  const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
  content = re.test(content) ? content.replace(re, line) : `${content.replace(/\s*$/, "")  }\n${  line  }\n`;
  writeFileSync(path, content, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort: a .env holds a secret */ }
}
