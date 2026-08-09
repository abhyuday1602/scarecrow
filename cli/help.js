// cli/help.js — version lookup and help text (global + per-command). Help is built
// from the same flag specs the parser uses (cli/args.js), so the two never drift.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { c, sym } from "./ui.js";
import { COMMANDS } from "./args.js";
import { ALL_PROVIDERS } from "./env.js";
import { PERSONAS } from "../personas.js";
import { providerInfo } from "../llm.js";
import { BRAND } from "./brand.js";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export function version() {
  try {
    return JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Indented persona list, reused by `personas` and the global help.
export const personaLines = () =>
  Object.entries(PERSONAS).map(([k, p]) => `  ${c.bold(k.padEnd(9))}${c.dim(p.name)}`);

const providerLines = () =>
  ALL_PROVIDERS.map((name) => {
    const p = providerInfo(name);
    const note = name === "anthropic" ? c.dim("(default)") : p.local ? c.dim("(local · no key)") : "";
    return `  ${c.bold(name.padEnd(10))}${c.dim((p.env || "local · no key").padEnd(20))}${c.dim(p.defaultModel)} ${note}`.trimEnd();
  });

// Render one flag's help row from its spec entry.
function flagRow(name, def) {
  const alias = def.alias ? `-${def.alias}, ` : "    ";
  const val = def.type === "string" ? " <value>"
    : def.type === "int" ? " <n>"
    : def.type === "optional" ? "[=val]"
    : "";
  const left = `${alias}--${name}${val}`;
  return `  ${left.padEnd(24)} ${c.dim(def.desc || "")}`;
}

export function globalHelp() {
  const cmds = Object.entries(COMMANDS)
    .map(([name, { summary }]) => `  ${c.bold(name.padEnd(10))}${c.dim(summary)}`)
    .join("\n");

  return `${c.bold(BRAND)} ${c.dim(`v${  version()}`)} ${c.dim(sym.dot)} synthetic user testing for your product

A chosen persona does a real click-through of your site toward a goal in a headless
browser, then reports the usability friction it hit (issue, severity, suggested fix).

${c.bold("USAGE")}
  crow ${c.dim("[command]")} ${c.dim("[options]")}
  crow ${c.dim("<url> [options]")}        ${c.dim("run a session (the default command)")}
  crow                      ${c.dim("guided interactive mode")}

${c.bold("COMMANDS")}
${cmds}

${c.bold("COMMON OPTIONS")}
  -p, --persona <key>      who is using the site
  -t, --task "..."         the goal the user is trying to accomplish
  -n, --steps <n>          max actions before stopping ${c.dim("(default 8)")}
      --provider <name>    anthropic | gemini | groq | ollama ${c.dim("(auto-detected)")}
  -m, --model <id>         override the model for the provider
      --no-headed          hide the browser window ${c.dim("(shown by default)")}
      --json               machine-readable output  ${c.dim("·")}  -q, --quiet  results only
  -h, --help               show help                 ${c.dim("·")}  -v, --version

${c.bold("PERSONAS")}
${personaLines().join("\n")}

${c.bold("PROVIDERS")} ${c.dim("(set the key for the one you want, in .env or your shell)")}
${providerLines().join("\n")}

${c.bold("EXAMPLES")}
  ${c.dim("# full click-through")}
  crow example.com -p skeptic -t "sign up for a free trial"

  ${c.dim("# quick first-impression of the whole page")}
  crow glance example.com --full -p novice -t "find pricing"

  ${c.dim("# watch it live in a real browser window")}
  crow example.com -p rushed -t "book a demo" --headed

  ${c.dim("# CI gate with an objective success check")}
  crow example.com -p power -t "create a project" --success "/projects/new" --ci

Run ${c.bold("crow help <command>")} for command-specific options, or ${c.bold("crow doctor")} to check setup.`;
}

// Per-command usage + options, plus a couple of tailored examples.
const USAGE = {
  run: "crow run [url] [options]",
  glance: "crow glance [url] [options]",
  personas: "crow personas [key]",
  doctor: "crow doctor",
  init: "crow init [--force]",
  config: "crow config [get <key> | set <key> <value> | unset <key> | path | reset]",
  help: "crow help [command]",
};
const EXTRA = {
  run: [
    "crow run example.com -p skeptic -t \"sign up\"",
    "crow run example.com -p power -t \"create a project\" --success \"/new\" --ci",
  ],
  glance: ["crow glance example.com --full -p novice -t \"find pricing\""],
  personas: ["crow personas", "crow personas skeptic"],
  config: ["crow config set persona skeptic", "crow config set steps 6", "crow config"],
  init: ["crow init"],
  doctor: ["crow doctor"],
};

export function commandHelp(cmd) {
  const entry = COMMANDS[cmd];
  if (!entry) return globalHelp();

  // Show command-specific flags first, then the global ones, each grouped.
  const globalKeys = new Set(["help", "version", "quiet", "json", "yes", "color"]);
  const own = [], glob = [];
  for (const [name, def] of Object.entries(entry.spec)) {
    if (name === "url") continue; // documented as the positional
    (globalKeys.has(name) ? glob : own).push(flagRow(name, def));
  }

  const parts = [
    `${c.bold(`crow ${  cmd}`)} ${c.dim(sym.dot)} ${entry.summary}`,
    "",
    `${c.bold("USAGE")}\n  ${USAGE[cmd] || `crow ${  cmd}`}`,
  ];
  if (own.length) parts.push("", `${c.bold("OPTIONS")}\n${own.join("\n")}`);
  if (glob.length) parts.push("", `${c.bold("GLOBAL")}\n${glob.join("\n")}`);
  if (EXTRA[cmd]?.length)
    parts.push("", `${c.bold("EXAMPLES")}\n${  EXTRA[cmd].map((e) => `  ${  c.dim(e)}`).join("\n")}`);

  return parts.join("\n");
}
