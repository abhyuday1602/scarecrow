// llm.js — one normalized chat() across four providers:
//   anthropic  → native Anthropic SDK (Claude models)
//   gemini     → OpenAI SDK pointed at Google's OpenAI-compatible endpoint
//   groq       → OpenAI SDK pointed at Groq's OpenAI-compatible endpoint
//   ollama     → OpenAI SDK pointed at a local Ollama daemon (keyless; localhost:11434)
//
// agent.js builds provider-neutral "parts" — [{text} | {image: base64png}] — and
// this module converts them into each provider's wire format and image shape.
//
// Pass onChunk to get streaming: each text fragment is delivered as it arrives. Pass a
// `tool` to get a structured (schema-checked) reply instead of free text — see chat().

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { logger } from "./cli/logger.js";

const PROVIDERS = {
  anthropic: {
    kind: "anthropic",
    env: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-6",
    signupUrl: "https://console.anthropic.com/settings/keys",
  },
  gemini: {
    kind: "openai",
    env: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-2.5-flash",
    signupUrl: "https://aistudio.google.com/apikey",
  },
  groq: {
    kind: "openai",
    env: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1",
    // Groq rotates its lineup often — confirm current IDs at
    // https://console.groq.com/docs/models and override with --model.
    // It MUST be a vision model; text-only models can't see the screenshots.
    defaultModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    signupUrl: "https://console.groq.com/keys",
  },
  ollama: {
    kind: "openai",
    // Local, keyless: an OpenAI-compatible server exposed by the Ollama daemon.
    // No API key — pass a placeholder in openaiClient(); no signupUrl (setupUrl instead).
    // Requires `ollama serve` running and a vision model pulled (e.g. `ollama pull qwen3-vl`).
    baseURL: "http://localhost:11434/v1",
    defaultModel: "qwen3-vl",
    local: true,
    setupUrl: "https://ollama.com/download",
  },
};

// Hand-verified shortlist per provider. The model picker marks these ★ suggested above
// whatever the provider's live listing returns; `--model`/`/model <id>` accepts anything,
// and this list is safe to edit. The first entry is the default.
export const SUGGESTED_MODELS = {
  anthropic: ["claude-sonnet-4-6", "claude-opus-5", "claude-sonnet-5"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  groq: ["meta-llama/llama-4-scout-17b-16e-instruct", "qwen/qwen3.6-27b"],
  // Ollama models are local: includes both vision and text-only options; the picker shows
  // install status and size. Bare names resolve the provider's default tag.
  ollama: ["qwen3-vl", "qwen3", "llama3.2-vision", "llama3.2", "llava", "moondream", "gemma3", "gemma2"],
};

// Approximate download / disk size for curated Ollama models (~ tag = default quant).
// Shown in the model picker as a download-size estimate; installed models show the real
// size from `ollama list`.
export const MODEL_SIZES = {
  "qwen3-vl":        "~8.5GB",
  "qwen3":           "~2.5GB",
  "llama3.2-vision": "~7.9GB",
  "llama3.2":        "~2.0GB",
  "llava":           "~4.5GB",
  "moondream":       "~1.7GB",
  "gemma3":          "~2.3GB",
  "gemma2":          "~1.6GB",
};

// The suggested picker options for a provider, guaranteeing the provider default is
// present and first even if the shortlist drifts. Also the offline fallback when the
// live listing (listModels) is unreachable.
export function modelsFor(name) {
  const def = PROVIDERS[name]?.defaultModel;
  const list = SUGGESTED_MODELS[name] || (def ? [def] : []);
  return def && !list.includes(def) ? [def, ...list] : list;
}

// Model ids that can't run Scarecrow (no chat/vision): speech, embeddings, image/video
// generation, safety filters. Filtered out of the live listing to keep the picker usable.
const NON_CHAT_MODEL = /whisper|tts|embed|imagen|veo|aqa|guard|moderation/i;

// Live model listing from the provider's API. Uses the same SDK clients as chat():
// models.list() natively for Anthropic, and via the OpenAI-compatible endpoints for
// gemini/groq (Gemini prefixes ids with "models/", which is normalized away). Throws on
// failure (offline, bad key). Not currently called by the TUI (its /model picker sticks to
// the curated modelsFor() list so it stays instant and offline-safe) — kept as a public
// building block for anything that wants a provider's full live model list.
export async function listModels(name, { timeoutMs = 4000 } = {}) {
  const p = providerInfo(name);
  const opts = { timeout: timeoutMs, maxRetries: 0 };
  const page = p.kind === "anthropic"
    ? await anthropicClient().models.list({ limit: 100 }, opts)
    : await openaiClient(p).models.list(opts);

  const ids = [];
  for await (const m of page) {
    const id = String(m.id).replace(/^models\//, "");
    if (!NON_CHAT_MODEL.test(id)) ids.push(id);
  }
  return ids;
}

export function providerInfo(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown provider "${name}". Choose: anthropic, gemini, groq, or ollama.`);
  return { name, ...p };
}

// SDK-free provider metadata for the TUI's provider picker & key-paste flow: just the
// fields those screens need. Importing this module still loads the SDKs, so callers
// dynamic-import it on user action (never at TUI startup).
export function listProviders() {
  return Object.entries(PROVIDERS).map(([name, p]) => ({
    name,
    local: !!p.local,
    env: p.env,
    signupUrl: p.signupUrl,
    setupUrl: p.setupUrl,
    defaultModel: p.defaultModel,
  }));
}

// Clients are created lazily (after .env is loaded) and reused — but rebuilt whenever the
// key they were built with changes, so a key pasted mid-session (TUI /provider) takes
// effect on the very next call instead of after a restart.
//
// maxRetries: 0 — the SDKs' own retry loop would wait silently (no countdown in the UI)
// and stack under chatWithRetry's, turning one rate-limited step into ~30 requests. All
// retrying happens in chatWithRetry, where every wait is reported. timeout fails a
// genuinely stuck call after a minute; chatWithRetry then retries it like any 5xx.
const CLIENT_OPTS = { maxRetries: 0, timeout: 60_000 };
let _anthropic = null;
const _openai = {};
function anthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!_anthropic || _anthropic.key !== key) _anthropic = { key, client: new Anthropic({ ...CLIENT_OPTS }) };
  return _anthropic.client;
}
function openaiClient(p) {
  // Local providers (Ollama) have no key; the SDK rejects an empty apiKey, so pass a
  // harmless placeholder — the local daemon ignores it.
  const key = p.env ? process.env[p.env] : "ollama";
  const cached = _openai[p.name];
  if (!cached || cached.key !== key) {
    _openai[p.name] = { key, client: new OpenAI({ apiKey: key, baseURL: p.baseURL, ...CLIENT_OPTS }) };
  }
  return _openai[p.name].client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isAbortError = (err) =>
  err?.name === "AbortError" || err?.code === "ABORT_ERR" || err?.constructor?.name === "APIUserAbortError";

// Classify an SDK error as retryable, and say why (shown in the countdown). Rate limits,
// overloaded/5xx responses, request timeouts and dropped connections are transient; 4xx
// request errors (bad key, bad model, bad payload) are not.
function retryReason(err) {
  const status = err?.status;
  const name = err?.constructor?.name || err?.name || "";
  if (status === 429 || name === "RateLimitError") return "rate limited";
  if (status === 408 || /Timeout/i.test(name)) return "timed out";
  if (status === 529 || (status >= 500 && status < 600)) return "provider error";
  if (status === undefined && /Connection/i.test(name)) return "connection error";
  return null;
}

// Extract the Retry-After header value (seconds or HTTP-date) from any SDK error
// that carries a Headers-like object. Returns null when the header is absent.
function getRetryAfterMs(err) {
  const h = err?.headers;
  if (!h) return null;
  const raw = typeof h.get === "function" ? h.get("retry-after") || h.get("Retry-After") : h["retry-after"];
  if (!raw) return null;
  const secs = Number(raw);
  if (!isNaN(secs)) return secs * 1000;
  const date = new Date(raw);
  if (!isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  return null;
}

// chat() with the one and only retry layer. Transient failures (see retryReason) are
// retried up to `maxRetries` attempts in total, waiting Retry-After when the provider
// sends it, else exponential backoff capped at 60s.
//   onRateLimit({ waitMs, attempt, maxRetries, reason }) — called before each retry wait,
//     responsible for both displaying the countdown AND waiting for the full duration.
export async function chatWithRetry(args) {
  const { onRateLimit, maxRetries = 5, ...chatArgs } = args;
  for (let attempt = 1; ; attempt++) {
    try {
      return await chat(chatArgs);
    } catch (err) {
      if (isAbortError(err) || chatArgs.signal?.aborted) throw err;
      const reason = retryReason(err);
      if (!reason) throw err;
      if (attempt >= maxRetries) {
        if (reason === "rate limited") {
          throw new Error(`Provider rate limit exceeded after ${maxRetries} retries. Check your API usage and quota, then start a new session.`, { cause: err });
        }
        throw err;
      }
      const waitMs = getRetryAfterMs(err) ?? Math.min(1000 * Math.pow(2, attempt), 60000);
      logger.log("RETRY", { reason, status: err?.status, waitMs, attempt, maxRetries });
      if (onRateLimit) await onRateLimit({ waitMs, attempt, maxRetries, reason });
      else await sleep(waitMs);
    }
  }
}

// Streams the value of one top-level string field (e.g. "thought") out of a JSON object
// that arrives in fragments — a tool call's argument deltas, or a JSON-mode response.
// Feed it raw JSON text; it calls onChunk with the decoded string content as it arrives
// (escapes resolved, even when split across fragments) and goes quiet after the closing
// quote. Exported for tests.
export function streamStringField(field, onChunk) {
  if (!onChunk) return () => {};
  const opener = new RegExp(`"${field}"\\s*:\\s*"`);
  let buf = "";      // raw JSON text seen so far, until the field's opening quote is found
  let state = "seek"; // seek → value → done
  let esc = null;    // pending escape sequence ("\\" or "\\uXX…")
  const ESC = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
  return (text) => {
    if (state === "done" || !text) return;
    let rest = text;
    if (state === "seek") {
      buf += text;
      const m = opener.exec(buf);
      if (!m) return;
      state = "value";
      rest = buf.slice(m.index + m[0].length);
      buf = "";
    }
    let out = "";
    for (const ch of rest) {
      if (esc !== null) {
        esc += ch;
        if (esc.length === 2 && esc[1] !== "u") { out += ESC[esc[1]] ?? esc[1]; esc = null; }
        else if (esc.length === 6) { out += String.fromCharCode(parseInt(esc.slice(2), 16)); esc = null; }
        continue;
      }
      if (ch === "\\") { esc = "\\"; continue; }
      if (ch === '"') { state = "done"; break; }
      out += ch;
    }
    if (out) onChunk(out);
  };
}

// Last-resort JSON extraction from free text (models that ignore tool/JSON mode). Prefers
// the last object that starts with one of `keys` (so prose containing "{" before the real
// object can't break it), then the whole text, then the outermost {...}. Exported for tests.
export function extractJson(text, keys = []) {
  const cleaned = String(text || "").replace(/```(?:json)?/g, "").trim();
  const tryParse = (s) => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : null; } catch { return null; } };
  for (const k of keys) {
    const re = new RegExp(`\\{\\s*"${k}"\\s*:`, "g");
    let last = -1, m;
    while ((m = re.exec(cleaned))) last = m.index;
    if (last >= 0) {
      const tail = cleaned.slice(last);
      for (let end = tail.lastIndexOf("}"); end > 0; end = tail.lastIndexOf("}", end - 1)) {
        const v = tryParse(tail.slice(0, end + 1));
        if (v) return v;
      }
    }
  }
  const whole = tryParse(cleaned);
  if (whole) return whole;
  const first = cleaned.indexOf("{"), last = cleaned.lastIndexOf("}");
  return first >= 0 && last > first ? tryParse(cleaned.slice(first, last + 1)) : null;
}

// --- record / replay ---------------------------------------------------------
// SCARECROW_LLM_CASSETTE=<file.json> with SCARECROW_LLM_MODE=record|replay makes runs
// deterministic for tests and evals: "record" saves every response keyed by a hash of the
// request; "replay" serves them back without touching the network and throws on a miss.
// A cassette may also hold a `sequence` array, served in call order to any request whose
// key isn't recorded — handy for hand-scripted test runs.
function cassetteKey({ provider, model, system, parts, tool }) {
  const shape = parts.map((x) => (x.image != null ? { image: x.image.length } : { text: x.text }));
  return createHash("sha256").update(JSON.stringify({ provider, model, system, shape, tool: tool?.name || null })).digest("hex").slice(0, 32);
}
const _cassettes = new Map(); // path → { entries, sequence, cursor }
function loadCassette(path) {
  if (!_cassettes.has(path)) {
    let data = {};
    try { data = JSON.parse(readFileSync(path, "utf8")); } catch { /* new cassette */ }
    _cassettes.set(path, { entries: data.entries || {}, sequence: data.sequence || [], cursor: 0 });
  }
  return _cassettes.get(path);
}
function replay(cassette, key, args) {
  const hit = cassette.entries[key] ?? cassette.sequence[cassette.cursor++];
  if (!hit) throw new Error(`LLM cassette miss (key ${key}) in replay mode — re-record the cassette.`);
  const text = hit.text ?? "";
  const input = hit.input ?? null;
  if (args.onChunk) {
    if (args.tool) {
      const v = input?.[args.tool.streamField];
      if (typeof v === "string") args.onChunk(v);
    } else if (text) args.onChunk(text);
  }
  return args.tool ? { text, input } : text;
}
function record(path, cassette, key, result) {
  cassette.entries[key] = typeof result === "string" ? { text: result } : result;
  writeFileSync(path, JSON.stringify({ entries: cassette.entries, sequence: cassette.sequence }, null, 2));
}

// Models/providers that rejected forced tool calls, so later calls skip straight to the
// JSON-schema fallback instead of failing once per step.
const _noTools = new Set();
const isToolUnsupported = (err) =>
  err?.status === 400 && /tool|function/i.test(String(err?.message || err?.error?.message || ""));
const isSchemaUnsupported = (err) =>
  err?.status === 400 && /response_format|json_schema|schema/i.test(String(err?.message || err?.error?.message || ""));

// parts: array of { text: string } and/or { image: base64PngString }
// onChunk: optional (text: string) => void — called with each streamed fragment. With a
//   `tool`, it receives the streamed value of tool.streamField instead of raw text.
// tool: optional { name, description, schema, streamField } — forces a structured reply
//   (Anthropic tool use; OpenAI-compatible tool calling, falling back to json_schema mode,
//   then plain JSON instructions for models that support neither). Returns { text, input }
//   where input is the parsed object (or null if the model never produced one). Without a
//   tool, returns the response text.
export async function chat(args) {
  const cassettePath = process.env.SCARECROW_LLM_CASSETTE;
  if (cassettePath) {
    const mode = process.env.SCARECROW_LLM_MODE || "replay";
    const cassette = loadCassette(cassettePath);
    const key = cassetteKey(args);
    if (mode === "replay") return replay(cassette, key, args);
    const result = await chatLive(args);
    record(cassettePath, cassette, key, result);
    return result;
  }
  return chatLive(args);
}

async function chatLive({ provider, model, system, parts, maxTokens = 1024, onChunk, signal, tool }) {
  const p = providerInfo(provider);
  const hasImages = parts.some((x) => x.image != null);
  const partsSummary = `${parts.length} part(s)${hasImages ? " +image" : ""}`;
  const startMs = Date.now();
  const sink = tool ? streamStringField(tool.streamField, onChunk) : onChunk;

  const logResponse = (responseText, extra = {}) => {
    logger.log("LLM_RESPONSE", {
      provider, model,
      duration_ms: Date.now() - startMs,
      input_tokens: extra.inputTokens ?? "?",
      output_tokens: extra.outputTokens ?? "?",
      total_tokens: extra.totalTokens
        ?? (Number.isFinite(extra.inputTokens) && Number.isFinite(extra.outputTokens) ? extra.inputTokens + extra.outputTokens : "?"),
      finish_reason: extra.finishReason ?? "?",
      ...(extra.mode ? { mode: extra.mode } : {}),
      // --no-log-responses (logger.logResponses === false) keeps timing/token metadata but
      // drops the response body itself.
      ...(logger.logResponses ? { response: (responseText || "").slice(0, 2000) } : {}),
    });
  };

  const logRequest = (extra = {}) => {
    logger.log("LLM_REQUEST", {
      provider, model, max_tokens: maxTokens,
      ...(logger.logResponses ? { system: (system || "").slice(0, 300) } : {}),
      parts: partsSummary,
      ...(tool ? { tool: tool.name } : {}),
      ...extra,
    });
  };

  if (p.kind === "anthropic") {
    const content = parts.map((x) =>
      x.image != null
        ? { type: "image", source: { type: "base64", media_type: "image/png", data: x.image } }
        : { type: "text", text: x.text }
    );
    const body = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
      ...(tool ? {
        tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
        tool_choice: { type: "tool", name: tool.name },
      } : {}),
    };

    let res;
    if (onChunk) {
      logRequest({ stream: true });
      const stream = anthropicClient().messages.stream(body, { signal });
      for await (const ev of stream) {
        if (ev.type !== "content_block_delta") continue;
        if (ev.delta.type === "text_delta" && !tool) sink(ev.delta.text);
        if (ev.delta.type === "input_json_delta") sink(ev.delta.partial_json);
      }
      res = await stream.finalMessage();
    } else {
      logRequest();
      res = await anthropicClient().messages.create(body, { signal });
    }
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const input = tool ? (res.content.find((b) => b.type === "tool_use")?.input ?? null) : undefined;
    logResponse(tool ? JSON.stringify(input) : text, {
      inputTokens: res.usage?.input_tokens,
      outputTokens: res.usage?.output_tokens,
      finishReason: res.stop_reason,
    });
    return tool ? { text, input } : text;
  }

  // OpenAI-compatible (gemini, groq, ollama)
  const content = parts.map((x) =>
    x.image != null
      ? { type: "image_url", image_url: { url: `data:image/png;base64,${x.image}` } }
      : { type: "text", text: x.text }
  );
  const toolKey = `${provider}::${model}`;
  const modes = !tool ? ["text"] : _noTools.has(toolKey) ? ["schema", "plain"] : ["tools", "schema", "plain"];

  for (let i = 0; i < modes.length; i++) {
    const mode = modes[i];
    const sys = mode === "plain"
      ? `${system || ""}\n\nRespond with ONLY a JSON object (no prose, no code fences) matching this JSON schema:\n${JSON.stringify(tool.schema)}`
      : system;
    const messages = [];
    if (sys) messages.push({ role: "system", content: sys });
    messages.push({ role: "user", content });
    const body = {
      model,
      max_tokens: maxTokens,
      messages,
      ...(mode === "tools" ? {
        tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
        tool_choice: "required", // a single tool, so "required" forces exactly this one
      } : {}),
      ...(mode === "schema" ? {
        response_format: { type: "json_schema", json_schema: { name: tool.name, schema: tool.schema } },
      } : {}),
    };

    try {
      let text = "", args = "", usage, finishReason;
      if (onChunk) {
        logRequest({ stream: true, mode });
        // include_usage: OpenAI-compatible streams only report token usage (in one final,
        // choice-less chunk) when asked; without it every streamed call logged "?".
        const stream = await openaiClient(p).chat.completions.create(
          { ...body, stream: true, stream_options: { include_usage: true } }, { signal });
        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) { text += delta.content; sink(delta.content); }
          for (const tc of delta?.tool_calls || []) {
            const frag = tc.function?.arguments;
            if (frag) { args += frag; sink(frag); }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) usage = chunk.usage;
        }
      } else {
        logRequest({ mode });
        const res = await openaiClient(p).chat.completions.create(body, { signal });
        const choice = res.choices?.[0];
        text = choice?.message?.content ?? "";
        args = (choice?.message?.tool_calls || []).map((tc) => tc.function?.arguments || "").join("");
        finishReason = choice?.finish_reason;
        usage = res.usage;
      }
      const input = tool ? (args ? extractJson(args) : extractJson(text, Object.keys(tool.schema.properties || {}))) : undefined;
      logResponse(tool ? (args || text) : text, {
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
        finishReason,
        mode: tool ? mode : undefined,
      });
      return tool ? { text, input } : text;
    } catch (err) {
      const last = i === modes.length - 1;
      if (!last && mode === "tools" && isToolUnsupported(err)) { _noTools.add(toolKey); continue; }
      if (!last && mode === "schema" && isSchemaUnsupported(err)) continue;
      throw err;
    }
  }
  throw new Error("unreachable");
}
