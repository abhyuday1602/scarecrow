// llm.js — one normalized chat() across four providers:
//   anthropic  → native Anthropic SDK (Claude models)
//   gemini     → OpenAI SDK pointed at Google's OpenAI-compatible endpoint
//   groq       → OpenAI SDK pointed at Groq's OpenAI-compatible endpoint
//   ollama     → OpenAI SDK pointed at a local Ollama daemon (keyless; localhost:11434)
//
// agent.js builds provider-neutral "parts" — [{text} | {image: base64png}] — and
// this module converts them into each provider's wire format and image shape.
//
// Pass onChunk to get streaming: each text fragment is delivered as it arrives.

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

// Precedence: explicit override > MODEL env var > provider default.
export function resolveModel(name, override) {
  return override !== undefined ? override : process.env.MODEL || providerInfo(name).defaultModel;
}

// Clients are created lazily (after .env is loaded) and reused.
let _anthropic;
const _openai = {};
// maxRetries: the SDKs do exponential backoff with jitter and honor Retry-After,
// so a transient 429/5xx/network blip mid-run won't waste the steps already paid
// for. timeout fails a genuinely stuck call in 2 min (then a retry kicks in).
const anthropicClient = () => (_anthropic ??= new Anthropic({ maxRetries: 5, timeout: 120_000 }));
const openaiClient = (p) =>
  (_openai[p.name] ??= new OpenAI({
    // Local providers (Ollama) have no key; the SDK rejects an empty apiKey, so pass a
    // harmless placeholder — the local daemon ignores it.
    apiKey: p.env ? process.env[p.env] : "ollama",
    baseURL: p.baseURL,
    maxRetries: 5,
    timeout: 120_000,
  }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Detect a rate-limit error (429) from either the Anthropic or OpenAI SDK.
function isRateLimitError(err) {
  return err?.status === 429 || err?.constructor?.name === "RateLimitError";
}

// Extract the Retry-After header value (seconds or HTTP-date) from any SDK error
// that carries a Headers-like object. Returns null when the header is absent.
function getRetryAfterMs(err) {
  const h = err?.headers;
  if (!h) return null;
  const raw = typeof h.get === "function" ? h.get("retry-after") || h.get("Retry-After") : null;
  if (!raw) return null;
  const secs = Number(raw);
  if (!isNaN(secs)) return secs * 1000;
  const date = new Date(raw);
  if (!isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  return null;
}

// Like chat(), but with automatic rate-limit retries backed by a live countdown.
//   onRateLimit({ waitMs, attempt, maxRetries }) — called before each retry wait,
//     responsible for both displaying the countdown AND waiting for the full duration.
//   maxRetries — total attempts made here (default 5), on top of the SDK's own 5.
export async function chatWithRetry(args) {
  const { onRateLimit, maxRetries = 5, ...chatArgs } = args;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await chat(chatArgs);
    } catch (err) {
      if (err?.name === "AbortError" || err?.code === "ABORT_ERR") throw err;
      if (attempt === maxRetries) {
        if (isRateLimitError(err)) {
          throw new Error(`Provider rate limit exceeded after ${maxRetries} retries. Check your API usage and quota, then start a new session.`, { cause: err });
        }
        throw err;
      }
      if (!isRateLimitError(err)) throw err;
      const waitMs = getRetryAfterMs(err) || Math.min(1000 * Math.pow(2, attempt), 60000);
      logger.log("RATE_LIMIT", { waitMs, attempt, maxRetries });
      if (onRateLimit) {
        await onRateLimit({ waitMs, attempt, maxRetries });
      } else {
        await sleep(waitMs);
      }
    }
  }
}

// parts: array of { text: string } and/or { image: base64PngString }
// onChunk: optional (text: string) => void — called with each streamed fragment
export async function chat({ provider, model, system, parts, maxTokens = 1024, onChunk, signal }) {
  const p = providerInfo(provider);
  const hasImages = parts.some((x) => x.image != null);
  const partsSummary = `${parts.length} part(s)${hasImages ? " +image" : ""}`;
  const startMs = Date.now();

  const logResponse = (responseText, extra = {}) => {
    logger.log("LLM_RESPONSE", {
      provider, model,
      duration_ms: Date.now() - startMs,
      input_tokens: extra.inputTokens ?? "?",
      output_tokens: extra.outputTokens ?? "?",
      total_tokens: extra.totalTokens ?? "?",
      finish_reason: extra.finishReason ?? "?",
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
      ...extra,
    });
  };

  if (p.kind === "anthropic") {
    const content = parts.map((x) =>
      x.image != null
        ? { type: "image", source: { type: "base64", media_type: "image/png", data: x.image } }
        : { type: "text", text: x.text }
    );

    if (onChunk) {
      logRequest({ stream: true });
      const stream = anthropicClient().messages.stream({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content }],
      }, { signal });
      let full = "";
      let inputTokens, outputTokens, stopReason;
      for await (const ev of stream) {
        if (ev.type === "message_start") {
          inputTokens = ev.message?.usage?.input_tokens;
        }
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          onChunk(ev.delta.text);
          full += ev.delta.text;
        }
        if (ev.type === "message_delta") {
          outputTokens = ev.usage?.output_tokens;
          stopReason = ev.delta?.stop_reason;
        }
      }
      logResponse(full, { inputTokens, outputTokens, finishReason: stopReason });
      return full;
    }

    logRequest();
    const res = await anthropicClient().messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
    }, { signal });
    const full = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    logResponse(full, {
      inputTokens: res.usage?.input_tokens,
      outputTokens: res.usage?.output_tokens,
      totalTokens: (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0),
      finishReason: res.stop_reason,
    });
    return full;
  }

  // OpenAI-compatible (gemini, groq)
  const content = parts.map((x) =>
    x.image != null
      ? { type: "image_url", image_url: { url: `data:image/png;base64,${x.image}` } }
      : { type: "text", text: x.text }
  );
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content });

  if (onChunk) {
    logRequest({ stream: true });
    const stream = await openaiClient(p).chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages,
      stream: true,
    }, { signal });
    let full = "";
    let usage;
    for await (const chunk of stream) {
      const text = chunk.choices?.[0]?.delta?.content;
      if (text != null) { onChunk(text); full += text; }
      if (chunk.usage) usage = chunk.usage;
    }
    logResponse(full, {
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      totalTokens: usage?.total_tokens,
      finishReason: usage ? "stop" : undefined,
    });
    return full;
  }

  logRequest();
  const res = await openaiClient(p).chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages,
  }, { signal });
  const full = res.choices?.[0]?.message?.content ?? "";
  logResponse(full, {
    inputTokens: res.usage?.prompt_tokens,
    outputTokens: res.usage?.completion_tokens,
    totalTokens: res.usage?.total_tokens,
    finishReason: res.choices?.[0]?.finish_reason,
  });
  return full;
}
