import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, ensureDir } from "./paths.js";

let _path = null;
let _runDir = null;
let _logResponses = true;

// Called by session.js to scope logs to the current run directory.
export function setLogDir(dir) { _runDir = dir; }

// Called by session.js from inputs.logResponses (--no-log-responses). When off, LLM prompt
// text and response bodies are left out of the log entirely — only metadata (timing, token
// counts, provider/model) is kept. Defaults to on, matching prior behavior.
export function setLogResponses(v) { _logResponses = !!v; }

// Common API-key shapes, so a key that ends up in a logged value (env var name typo, a
// pasted key inside a --task string, etc.) never lands in a plaintext log file.
const SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,        // Anthropic
  /AIza[0-9A-Za-z_-]{20,}/g,           // Google / Gemini
  /gsk_[a-zA-Z0-9]{20,}/g,             // Groq
  /\bBearer\s+[a-zA-Z0-9._-]{20,}/gi,  // generic bearer tokens
];
function redact(s) {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "«redacted»");
  return out;
}

function log(event, data = {}) {
  if (!_path) {
    // Write into the run directory when one has been set, otherwise fall back
    // to the XDG config dir — never to process.cwd(), which is unpredictable
    // for a globally installed CLI.
    const dir = _runDir
      ? join(_runDir, "logs")
      : join(configDir(), "logs");
    ensureDir(dir);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    _path = join(dir, `${ts}.log`);
  }
  const parts = [new Date().toISOString(), event];
  for (const [k, v] of Object.entries(data)) {
    // Collapse whitespace (incl. newlines) to keep entries one line, then escape the `|`
    // field delimiter itself so a value can't forge extra k=v fields, then redact secrets.
    const clean = redact(String(v).replace(/\s+/g, " ").replace(/\|/g, "¦")).slice(0, 500);
    parts.push(`${k}=${clean}`);
  }
  const line = `${parts.join(" | ")}\n`;
  appendFileSync(_path, line, "utf-8");
}

export const logger = { log, get path() { return _path; }, get logResponses() { return _logResponses; } };
export { redact };
