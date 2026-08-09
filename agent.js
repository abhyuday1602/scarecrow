// Agent layer — the persona's brain. Now provider-agnostic: every call goes through
// chat() in llm.js and takes a cfg = { provider, model }.
//   - decideStep: pick ONE action from the current screenshot + labeled elements
//   - debrief:    turn the whole session transcript into structured findings
//   - glance:     single-screenshot first-impression critique (the --glance mode)
//
// All three accept an onChunk callback for streaming. The callback receives only the
// prose portion of the response (thought / narration), not the trailing JSON.

import { chatWithRetry } from "./llm.js";
import { logger } from "./cli/logger.js";

// Pull a JSON object out of a model response even if it's wrapped in prose/fences.
// Exported for tests.
export function safeJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

// Returns an onChunk wrapper that streams text up to (but not including) delimiter.
// Holds back the last (delimiter.length - 1) chars while searching, so a delimiter
// split across two chunks never leaks a partial prefix to the terminal. For a
// single-char delimiter (e.g. "{") nothing is held back — identical to emitting live.
// Exported for tests.
export function stopAtDelimiter(onChunk, delimiter) {
  if (!onChunk) return undefined;
  const hold = delimiter.length - 1;
  let buf = "", stopped = false, emitted = 0;
  return (text) => {
    buf += text;
    if (stopped) return;
    const j = buf.indexOf(delimiter);
    if (j !== -1) {
      if (j > emitted) onChunk(buf.slice(emitted, j));
      stopped = true;
      return;
    }
    const safe = buf.length - hold; // keep a possible partial delimiter unflushed
    if (safe > emitted) { onChunk(buf.slice(emitted, safe)); emitted = safe; }
  };
}

// Returns an onChunk wrapper that drops <think-aloud> / </think-aloud> markers from the
// streamed text. The model is asked to wrap its narration in them, and glance() strips
// them from the returned narration — but without this the raw tags flash up on screen as
// the answer streams, which is the first thing a `crow glance` user ever sees.
// Only a trailing fragment that could still grow into one of the two tags is held back,
// so ordinary prose containing "<" is never buffered indefinitely. Exported for tests.
export function stripThinkAloud(onChunk) {
  if (!onChunk) return undefined;
  const OPEN = "<think-aloud>", CLOSE = "</think-aloud>";
  const couldStartTag = (s) => OPEN.startsWith(s) || CLOSE.startsWith(s);
  let buf = "";
  return (text) => {
    buf += text;
    let keep = 0;
    for (let i = Math.max(0, buf.length - CLOSE.length + 1); i < buf.length; i++) {
      if (buf[i] === "<" && couldStartTag(buf.slice(i))) { keep = buf.length - i; break; }
    }
    const out = buf.slice(0, buf.length - keep).replace(/<\/?think-aloud>/gi, "");
    buf = buf.slice(buf.length - keep);
    if (out) onChunk(out);
  };
}

// ---- one step of the session ----------------------------------------------
export async function decideStep({ cfg, persona, goal, stepNum, maxSteps, history, elements, screenshotB64, uploadReady, routeContext, onChunk, onRateLimit, signal }) {
  const system = `${persona.description}

You are browsing a real website to accomplish this goal: "${goal}".

Behave like a real, impatient human — NOT a polite assistant. React only to what you
can actually see. If there's no clear path, scroll to look for one, or give up and
bounce. NEVER pretend you succeeded.

The screenshot has numbered red badges on every interactive element. The list maps
each number to an element. Choose exactly ONE action:
- "click"  + "target": click that numbered element
- "type"   + "target" + "text": type into that field (you'll usually click a button next step)
- "scroll": scroll down to see more of the page
- "scrollup": scroll back up if you need to revisit something above
- "wait":   wait for something to finish loading
- "done":   you believe you've accomplished the goal
- "giveup": you'd abandon this — explain why in your thought
${uploadReady ? `\nIf the page asks you to upload a file or document, a test file is ready: just "click" the upload control (button, link, or drop area) and it attaches automatically — there is no file dialog for you to deal with, and the next screenshot will show it attached.\n` : ""}
First, think out loud — 1 or 2 sentences, first person, present tense, reacting to what you see.
Then on a new line write ONLY this JSON (no markdown fences):
{"action":"click|type|scroll|scrollup|wait|done|giveup","target":<number or null>,"text":"<text to type, or null>"}`;

  const elemList =
    elements.map((e) => `[#${e.idx}] ${e.type}: ${e.label}`).join("\n") ||
    "(no interactive elements detected)";
  const hist = history.length
    ? `What you've done so far:\n${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}\n\n`
    : "";
  const routeInfo = routeContext
    ? `\nPages visited so far:\n${routeContext}\n`
    : "";
  const routePrefix = routeInfo ? `${routeInfo}\n` : "";
  const userText = `${hist}Step ${stepNum} of ${maxSteps}. ${routePrefix}Interactive elements visible now:\n${elemList}\n\nWhat do you do?`;

  const ask = (extra = "", withStream = true) =>
    chatWithRetry({
      provider: cfg.provider,
      model: cfg.model,
      system,
      parts: [{ image: screenshotB64 }, { text: userText + extra }],
      // Thinking models (e.g. Gemini 2.5) spend reasoning tokens from this same
      // budget on OpenAI-compatible endpoints — keep headroom above the ~100
      // visible tokens a step actually needs.
      maxTokens: 2000,
      onChunk: withStream ? stopAtDelimiter(onChunk, '{"action":') : undefined,
      onRateLimit,
      signal,
    });

  logger.log("LLM_START", { step: stepNum, total: maxSteps });
  let raw = await ask();
  logger.log("LLM_END", { step: stepNum, total: maxSteps });
  let parsed = safeJson(raw);
  if (!parsed || !parsed.action) {
    // Re-ask without streaming (already saw the first attempt's output).
    raw = await ask("\n\nReturn ONLY the JSON object — no prose, no markdown, no code fences.", false);
    parsed = safeJson(raw);
  }
  if (!parsed || !parsed.action) {
    return { thought: "(couldn't parse my own reaction — bailing)", action: "giveup", target: null, text: null };
  }

  // Extract thought from the prose that came before the JSON block.
  const jsonIdx = raw.indexOf("{");
  if (!parsed.thought && jsonIdx > 0) {
    parsed.thought = raw.slice(0, jsonIdx).trim();
  }
  parsed.thought = parsed.thought || "(no thought)";
  return parsed;
}

// ---- end-of-session structured findings ------------------------------------
export async function debrief({ cfg, persona, goal, transcript, outcome, signal, onChunk, onRateLimit, abortSignal }) {
  const system = `${persona.description}

You (${persona.name}) just finished a usability test with this goal: "${goal}".
Session outcome: ${outcome}.

Below is the full transcript — your own thoughts and what happened after each action.
Now step back and report what you learned. Use a researcher's structure, but stay
calibrated to who you are: rate each finding's severity by how badly it hurt THIS
user (your severity rules above), and answer "wouldCompleteTask" for this user —
not for some average visitor.
${signal ? `\nObjective ground truth from the page is included at the top of the transcript. If an objective success check is present, let it decide "wouldCompleteTask" rather than your impression.\n` : ""}
First, write 2–3 sentences of your raw overall reaction as this user — plain prose, first person.
Then on a new line, write ONLY this JSON (no fences or explanation):
{"summary":"one-sentence verdict","wouldCompleteTask":"yes|unsure|no","findings":[{"issue":"specific friction you hit","severity":"low|medium|high","heuristic":"usability principle it violates","fix":"concrete change"}]}`;

  logger.log("LLM_START", { step: "debrief" });
  const raw = await chatWithRetry({
    provider: cfg.provider,
    model: cfg.model,
    system,
    parts: [{ text: signal ? `${signal}\n\n--- transcript ---\n${transcript}` : transcript }],
    signal: abortSignal,
    // Generous: reasoning tokens (thinking models) + the full findings JSON both
    // draw from this budget; 2500 was observed truncating mid-JSON on gemini-2.5.
    maxTokens: 8000,
    onChunk: stopAtDelimiter(onChunk, '{"summary":'),
    onRateLimit,
  });
  logger.log("LLM_END", { step: "debrief" });
  return (
    safeJson(raw) || {
      summary: "(couldn't parse findings)",
      wouldCompleteTask: "unsure",
      findings: [],
      _raw: raw,
    }
  );
}

// ---- single-screenshot first impression (--glance) -------------------------
export async function glance({ cfg, persona, goal, screenshotB64, fullPage, onChunk, onRateLimit, abortSignal }) {
  const system = `${persona.description}

You're using a website with this goal: "${goal}". You're shown a screenshot of the
page${fullPage ? " (the full scrollable page)" : " exactly as it first loads"}.

React like a real, impatient human, not a polite assistant. Respond only to what's
visible, hesitate when the path is unclear (that's a finding), and be quick to blame
the interface. Don't be generous.

Respond in TWO parts, exactly:

<think-aloud>
2–4 short paragraphs, first person, present tense — your live reactions toward your goal.
</think-aloud>

=== FINDINGS ===
{"summary":"one-sentence verdict","wouldCompleteTask":"yes|unsure|no","findings":[{"issue":"...","severity":"low|medium|high","heuristic":"principle violated","fix":"concrete change"}]}`;

  logger.log("LLM_START", { step: "glance" });
  const raw = await chatWithRetry({
    provider: cfg.provider,
    model: cfg.model,
    system,
    parts: [{ image: screenshotB64 }, { text: "This is the page. Go." }],
    maxTokens: 8000, // same reasoning-token headroom as debrief
    onChunk: stopAtDelimiter(stripThinkAloud(onChunk), "=== FINDINGS"),
    onRateLimit,
    signal: abortSignal,
  });
  const [rawNarr, rawFind = ""] = raw.split(/===\s*FINDINGS\s*===/i);
  return {
    narration: rawNarr.replace(/<\/?think-aloud>/gi, "").trim(),
    findings: safeJson(rawFind),
    rawFindings: rawFind.replace(/```json|```/g, "").trim(),
  };
}
