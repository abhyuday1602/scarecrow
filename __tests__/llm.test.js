// llm.js against mocked SDKs: structured (tool) output, streaming of the tool's text field,
// token usage + finish_reason logging, the JSON-schema fallback, client refresh on a key
// change, and the single retry layer.
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = { openai: [], anthropic: [], openaiClients: 0 };
let openaiImpl = async () => { throw new Error("not set"); };
let anthropicImpl = async () => { throw new Error("not set"); };

vi.mock("openai", () => ({
  default: class {
    constructor(opts) { calls.openaiClients++; this.opts = opts; }
    chat = { completions: { create: (body, opts) => { calls.openai.push({ body, opts, apiKey: this.opts.apiKey }); return openaiImpl(body); } } };
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: (body) => { calls.anthropic.push(body); return anthropicImpl(body); },
      stream: (body) => { calls.anthropic.push(body); return anthropicImpl(body, true); },
    };
  },
}));

const logged = [];
vi.mock("../cli/logger.js", () => ({
  logger: { log: (event, data) => logged.push({ event, data }), logResponses: true },
}));

const { chat, chatWithRetry } = await import("../llm.js");

const TOOL = {
  name: "decide_step", description: "d", streamField: "thought",
  schema: { type: "object", properties: { thought: { type: "string" }, action: { type: "string" } }, required: ["thought", "action"] },
};
const asyncIter = (items) => ({ async *[Symbol.asyncIterator]() { for (const i of items) yield i; } });
const lastResponse = () => logged.filter((l) => l.event === "LLM_RESPONSE").at(-1).data;

beforeEach(() => {
  calls.openai.length = 0; calls.anthropic.length = 0; logged.length = 0;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("OpenAI-compatible providers", () => {
  it("streams the tool's thought, parses the arguments, and logs usage + finish_reason", async () => {
    openaiImpl = async () => asyncIter([
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"thou' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: 'ght":"Hi there","action":"scroll"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    ]);
    const chunks = [];
    const res = await chat({ provider: "gemini", model: "m", system: "s", parts: [{ text: "x" }], tool: TOOL, onChunk: (t) => chunks.push(t) });
    expect(res.input).toEqual({ thought: "Hi there", action: "scroll" });
    expect(chunks.join("")).toBe("Hi there");
    const body = calls.openai[0].body;
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools[0].function.name).toBe("decide_step");
    expect(lastResponse()).toMatchObject({ input_tokens: 100, output_tokens: 20, total_tokens: 120, finish_reason: "tool_calls" });
  });

  it("falls back to json_schema mode when the model rejects tools, and remembers that", async () => {
    openaiImpl = async (body) => {
      if (body.tools) throw Object.assign(new Error("this model does not support tools"), { status: 400 });
      return { choices: [{ message: { content: '{"thought":"ok","action":"done"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } };
    };
    const args = { provider: "gemini", model: "no-tools-model", system: "s", parts: [{ text: "x" }], tool: TOOL };
    expect((await chat(args)).input).toEqual({ thought: "ok", action: "done" });
    expect(calls.openai.map((c) => (c.body.tools ? "tools" : c.body.response_format ? "schema" : "plain"))).toEqual(["tools", "schema"]);
    calls.openai.length = 0;
    await chat(args);
    expect(calls.openai.map((c) => (c.body.tools ? "tools" : "schema"))).toEqual(["schema"]);
    expect(lastResponse()).toMatchObject({ total_tokens: 3, finish_reason: "stop" });
  });

  it("rebuilds the client when the API key changes", async () => {
    openaiImpl = async () => ({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] });
    await chat({ provider: "gemini", model: "m", parts: [{ text: "x" }] });
    process.env.GEMINI_API_KEY = "new-key";
    await chat({ provider: "gemini", model: "m", parts: [{ text: "x" }] });
    expect(calls.openai.map((c) => c.apiKey).slice(-2)).toEqual(["test-key", "new-key"]);
  });
});

describe("Anthropic", () => {
  it("forces the tool and streams its input_json deltas", async () => {
    // Like the real SDK: messages.stream() returns the stream synchronously.
    anthropicImpl = (body, streaming) => {
      const final = { content: [{ type: "tool_use", input: { thought: "Hmm", action: "back" } }], usage: { input_tokens: 5, output_tokens: 6 }, stop_reason: "tool_use" };
      if (!streaming) return Promise.resolve(final);
      return Object.assign(asyncIter([
        { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"thought": "Hm' } },
        { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: 'm", "action": "back"}' } },
      ]), { finalMessage: async () => final });
    };
    const chunks = [];
    const res = await chat({ provider: "anthropic", model: "c", system: "s", parts: [{ text: "x" }], tool: TOOL, onChunk: (t) => chunks.push(t) });
    expect(res.input).toEqual({ thought: "Hmm", action: "back" });
    expect(chunks.join("")).toBe("Hmm");
    expect(calls.anthropic[0].tool_choice).toEqual({ type: "tool", name: "decide_step" });
    expect(lastResponse()).toMatchObject({ input_tokens: 5, output_tokens: 6, total_tokens: 11, finish_reason: "tool_use" });
  });
});

describe("chatWithRetry (the only retry layer)", () => {
  const rateLimited = () => Object.assign(new Error("429"), { status: 429, headers: new globalThis.Headers({ "retry-after": "0" }) });

  it("makes at most maxRetries requests for a persistent 429, reporting each wait", async () => {
    openaiImpl = async () => { throw rateLimited(); };
    const waits = [];
    await expect(chatWithRetry({
      provider: "gemini", model: "m", parts: [{ text: "x" }],
      onRateLimit: async (w) => { waits.push(w.reason); },
    })).rejects.toThrow(/rate limit exceeded after 5 retries/);
    expect(calls.openai).toHaveLength(5);
    expect(waits).toEqual(["rate limited", "rate limited", "rate limited", "rate limited"]);
  });

  it("retries a 5xx and then succeeds", async () => {
    let n = 0;
    openaiImpl = async () => {
      if (n++ === 0) throw Object.assign(new Error("overloaded"), { status: 503 });
      return { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
    };
    const reasons = [];
    const res = await chatWithRetry({ provider: "gemini", model: "m", parts: [{ text: "x" }], onRateLimit: async (w) => reasons.push(w.reason) });
    expect(res).toBe("ok");
    expect(reasons).toEqual(["provider error"]);
  });

  it("does not retry a 400 or an abort", async () => {
    openaiImpl = async () => { throw Object.assign(new Error("bad request"), { status: 400 }); };
    await expect(chatWithRetry({ provider: "gemini", model: "m", parts: [{ text: "x" }] })).rejects.toThrow("bad request");
    expect(calls.openai).toHaveLength(1);
    const ac = new AbortController(); ac.abort();
    openaiImpl = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
    await expect(chatWithRetry({ provider: "gemini", model: "m", parts: [{ text: "x" }], signal: ac.signal })).rejects.toThrow("aborted");
    expect(calls.openai).toHaveLength(2);
  });
});
