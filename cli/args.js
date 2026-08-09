// cli/args.js — argument parsing: subcommands, typed flags with short aliases,
// `--k=v` / `--k v` / `-k v` / `-abc` (clustered bools) / `--no-flag` negation,
// `--` passthrough, and "did you mean" suggestions for unknown flags. No deps.
//
// Each command declares a flag spec; GLOBAL flags are merged into every command so
// things like -h/--help and --json work everywhere. parse() returns
// { command, positionals, flags, errors } and never throws on bad input — the
// router decides what to do with errors.

// --- flag specs -------------------------------------------------------------
const GLOBAL = {
  help:    { type: "bool",   alias: "h", desc: "show this help" },
  version: { type: "bool",   alias: "v", desc: "print the version" },
  quiet:   { type: "bool",   alias: "q", desc: "hide the streamed thinking; show results only" },
  json:    { type: "bool",               desc: "machine-readable output (implies --quiet)" },
  yes:     { type: "bool",   alias: "y", desc: "skip the confirmation prompt" },
  color:   { type: "bool",               desc: "force color (use --no-color to disable)" },
  theme:   { type: "string",             desc: "TUI color theme (cursor, gotham, … — pick interactively with /theme)" },
};

// Flags shared by run + glance (both drive a persona against a page).
const SHARED = {
  persona:  { type: "string", alias: "p", desc: "persona key (see `crow personas`)" },
  task:     { type: "string", alias: "t", desc: "the goal the user is trying to accomplish" },
  provider: { type: "string",             desc: "anthropic | gemini | groq | ollama (auto-detected)" },
  model:    { type: "string", alias: "m", desc: "override the model for the provider" },
  upload:   { type: "optional",           desc: "attach file(s) at an upload picker (bare = all of uploads/)" },
  headed:   { type: "bool",               desc: "show the browser window (default; --no-headed to hide)" },
  url:      { type: "string",             desc: "the URL to test (usually passed positionally)" },
  device:   { type: "string",             desc: "viewport preset: mobile | tablet | desktop (default) | desktop-lg | desktop-xl" },
  "log-responses": { type: "bool",        desc: "log full LLM prompts/responses to the run log (default: on; --no-log-responses to redact)" },
};

const RUN = {
  ...SHARED,
  steps:   { type: "int",    alias: "n", desc: "max actions before stopping (default 8)" },
  success: { type: "string",             desc: "pass/fail check: text or URL substring to find" },
  ci:      { type: "bool",               desc: "exit non-zero on failure or any high-severity finding" },
  out:     { type: "string", alias: "o", desc: "directory for run artifacts (default: ~/.config/scarecrow/runs)" },
  glance:  { type: "bool",               desc: "shortcut: do a glance instead of a session" },
  record:  { type: "bool",               desc: "save a video recording of the session" },
  batch:   { type: "string",             desc: "batch config file: JSON array of {url, persona, task, ...} entries" },
  a11y:    { type: "bool",               desc: "run accessibility audit (axe-core) on each page" },
};

const GLANCE = {
  ...SHARED,
  full:    { type: "bool",               desc: "critique the whole scrollable page" },
};

export const COMMANDS = {
  run:      { summary: "Full click-through session (the default command)", spec: { ...GLOBAL, ...RUN } },
  glance:   { summary: "One first-impression critique, no click-through",  spec: { ...GLOBAL, ...GLANCE } },
  export:   { summary: "Export findings in HTML, JUnit, or JSON format",   spec: { ...GLOBAL, format: { type: "string", alias: "f", desc: "export format: html | junit | xml | json" }, input: { type: "string", alias: "i", desc: "path to findings.json" }, out: { type: "string", alias: "o", desc: "output directory" } } },
  resume:   { summary: "Show a past session and the command to re-run it",     spec: { ...GLOBAL, list: { type: "bool", desc: "list past sessions" }, session: { type: "string", desc: "session directory to load" } } },
  diff:     { summary: "Compare two runs and show differences",           spec: { ...GLOBAL, list: { type: "bool", desc: "list all runs in the runs directory" }, run1: { type: "string", desc: "first run directory" }, run2: { type: "string", desc: "second run directory" } } },
  personas: { summary: "List the personas, or show one in detail",          spec: { ...GLOBAL } },
  doctor:   { summary: "Check Node, the browser, keys, and config",         spec: { ...GLOBAL } },
  init:     { summary: "Scaffold a .env and the uploads/ folder",           spec: { ...GLOBAL, force: { type: "bool", desc: "overwrite an existing .env" } } },
  config:   { summary: "Get/set saved defaults (provider, persona, …)",     spec: { ...GLOBAL } },
  help:     { summary: "Show help for a command",                            spec: { ...GLOBAL } },
};

// --- helpers ----------------------------------------------------------------
// A token looks like a URL/host (vs. a mistyped command, or free-typed goal text) if it
// has a scheme, a dot, a port colon, a path slash, or is localhost — but never if it
// contains whitespace. A real URL/host is always one unbroken token; a multi-word line
// (a TUI goal, a sentence) can pick up a stray "." or "/" from punctuation, decimals, an
// email address, "and/or", a date, etc., without being a URL at all.
export const looksLikeUrl = (s) =>
  !/\s/.test(s) &&
  (/^https?:\/\//i.test(s) || /[./]/.test(s) || /:\d/.test(s) || /^localhost\b/i.test(s));

// Default bare hosts to https:// so users can type "acme.com" everywhere a URL is taken.
// An input counts as already having an explicit scheme only when the colon isn't
// immediately followed by digits — "localhost:3000" and "example.com:8080" are the
// "host:port" shorthand (colon+digits) and still get "https://" prepended, but "file:///x",
// "javascript:alert(1)", "data:text/html,…" are left untouched. This matters: an
// unconditional prepend would otherwise mangle "file:///etc/passwd" into
// "https://file:///etc/passwd" *before* assertSafeTarget (below) ever sees the real scheme,
// silently defeating that check.
const HAS_EXPLICIT_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:(\/\/|[^0-9])/;
export const normalizeUrl = (u) => (HAS_EXPLICIT_SCHEME.test(u) ? u : `https://${u}`);

// Reject dangerous navigation targets before the browser ever opens them. Scheme must be
// http(s) — file://, data:, javascript: etc. would let a malicious/compromised page (or a
// mistyped flag) pull the local filesystem into a screenshot/page-text that gets sent to
// the LLM. Link-local addresses (169.254.0.0/16, which includes the 169.254.169.254 cloud
// metadata endpoint on AWS/GCP/Azure) are rejected too — no legitimate test target lives
// there, and it's the classic SSRF pivot for stealing cloud credentials.
//
// localhost / 127.0.0.1 / RFC1918 (10.x, 172.16-31.x, 192.168.x) are deliberately ALLOWED:
// testing your own dev/staging server on this machine or LAN is a primary use case, not an
// attack surface, for a local CLI tool like this one. Throws a plain Error; callers wrap it
// in UserError for display.
export function assertSafeTarget(u) {
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error(`"${u}" isn't a valid URL.`); }
  if (!/^https?:$/.test(parsed.protocol))
    throw new Error(`Refusing to open "${parsed.protocol}" URLs — only http:// and https:// are allowed.`);
  const host = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isLinkLocal(host))
    throw new Error(`Refusing to open a link-local address (${host}) — this range includes cloud metadata endpoints.`);
}

function isLinkLocal(host) {
  const v4 = host.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/i);
  if (v4) return Number(v4[1]) === 169 && Number(v4[2]) === 254; // 169.254.0.0/16
  return /^fe[89ab][0-9a-f]:/i.test(host); // IPv6 link-local, fe80::/10
}

function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return d[m][n];
}

export function suggest(word, candidates) {
  let best = null, bestD = Infinity;
  for (const cand of candidates) {
    const d = lev(word, cand);
    if (d < bestD) { bestD = d; best = cand; }
  }
  return bestD <= Math.max(2, Math.ceil(word.length / 3)) ? best : null;
}

// --- the parser -------------------------------------------------------------
export function parse(argv) {
  const out = { command: null, positionals: [], flags: {}, errors: [] };

  // Command = the first bare token that names a known command. (A bare token that
  // isn't a command — e.g. a URL — is left as a positional for the router.)
  let rest = argv;
  const firstBare = argv.find((a) => !a.startsWith("-"));
  if (firstBare && COMMANDS[firstBare]) {
    out.command = firstBare;
    const i = argv.indexOf(firstBare);
    rest = argv.slice(0, i).concat(argv.slice(i + 1));
  }

  const spec = COMMANDS[out.command || "run"].spec;
  const aliases = {};
  for (const [name, def] of Object.entries(spec)) if (def.alias) aliases[def.alias] = name;
  const fullNames = Object.keys(spec);

  const coerce = (name, def, raw) => {
    if (def.type === "int") {
      const n = Number(raw);
      if (!Number.isInteger(n)) { out.errors.push(`--${name} expects a whole number (got "${raw}")`); return undefined; }
      return n;
    }
    return raw;
  };
  const unknown = (flag) => {
    const near = suggest(flag.replace(/^-+/, ""), fullNames);
    return `unknown option "${flag}"${  near ? ` — did you mean "--${near}"?` : ""}`;
  };
  // A negative number is a *value*, not a flag: without this "-n -5" consumed nothing and
  // "-5" fell through as an unknown option ("did you mean --ci?"), hiding the real problem.
  const isFlagToken = (t) => t !== undefined && t.startsWith("-") && t !== "-" && !/^-\d/.test(t);

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];

    if (tok === "--") { out.positionals.push(...rest.slice(i + 1)); break; }

    // --- long flags ---
    if (tok.startsWith("--")) {
      let body = tok.slice(2), inlineVal;
      const eq = body.indexOf("=");
      if (eq !== -1) { inlineVal = body.slice(eq + 1); body = body.slice(0, eq); }

      let negated = false;
      if (body.startsWith("no-") && Object.hasOwn(spec, body.slice(3)) && spec[body.slice(3)].type === "bool") { negated = true; body = body.slice(3); }

      // Object.hasOwn (not `spec[body]`) so inherited props — __proto__, toString,
      // constructor, … — are rejected as unknown rather than treated as flags.
      const def = Object.hasOwn(spec, body) ? spec[body] : undefined;
      if (!def) { out.errors.push(unknown(`--${  body}`)); continue; }
      if (def.type === "bool") { out.flags[body] = !negated; continue; }
      if (def.type === "optional") {
        let val = inlineVal;
        if (val === undefined && !isFlagToken(rest[i + 1]) && rest[i + 1] !== undefined) val = rest[++i];
        out.flags[body] = val ?? true;
        continue;
      }

      let val = inlineVal;
      if (val === undefined) {
        if (!isFlagToken(rest[i + 1]) && rest[i + 1] !== undefined) val = rest[++i];
        else { out.errors.push(`--${body} expects a value`); continue; }
      }
      const cv = coerce(body, def, val);
      if (cv !== undefined) out.flags[body] = cv;
      continue;
    }

    // --- short flags ---
    if (tok.startsWith("-")) {
      let body = tok.slice(1), inlineVal;
      const eq = body.indexOf("=");
      if (eq !== -1) { inlineVal = body.slice(eq + 1); body = body.slice(0, eq); }

      // clustered booleans, e.g. -qy (only when every letter is a known bool alias)
      const isBoolAlias = (ch) => Object.hasOwn(aliases, ch) && spec[aliases[ch]].type === "bool";
      if (body.length > 1 && inlineVal === undefined && [...body].every(isBoolAlias)) {
        for (const ch of body) out.flags[aliases[ch]] = true;
        continue;
      }

      const name = Object.hasOwn(aliases, body) ? aliases[body] : undefined;
      if (!name) { out.errors.push(unknown(`-${  body}`)); continue; }
      const def = spec[name];
      if (def.type === "bool") { out.flags[name] = true; continue; }
      if (def.type === "optional") {
        let val = inlineVal;
        if (val === undefined && !isFlagToken(rest[i + 1]) && rest[i + 1] !== undefined) val = rest[++i];
        out.flags[name] = val ?? true;
        continue;
      }

      let val = inlineVal;
      if (val === undefined) {
        if (!isFlagToken(rest[i + 1]) && rest[i + 1] !== undefined) val = rest[++i];
        else { out.errors.push(`-${body} expects a value`); continue; }
      }
      const cv = coerce(name, def, val);
      if (cv !== undefined) out.flags[name] = cv;
      continue;
    }

    out.positionals.push(tok);
  }

  return out;
}
