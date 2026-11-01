// Agent layer — the persona's brain. Provider-agnostic: every call goes through
// chatWithRetry() in llm.js and takes a cfg = { provider, model }.
//   - decideStep: pick ONE action from the current screenshot + labeled elements
//   - debrief:    turn the whole session transcript into structured findings
//   - glance:     single-screenshot first-impression critique (the --glance mode)
//
// Every reply is structured: the model fills in a tool/JSON-schema object rather than
// writing prose with a JSON blob tacked on the end, so there's nothing to regex out of
// free text. The persona's voice still streams live — onChunk receives the object's
// "thought" (decideStep) or "reaction" (debrief, glance) field as it's generated.

import { chatWithRetry } from "./llm.js";
import { logger } from "./cli/logger.js";

export const ACTIONS = ["click", "type", "select", "press", "hover", "scroll", "scrollup", "back", "wait", "done", "giveup"];
export const KEYS = ["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Space"];

const DECIDE_TOOL = {
  name: "decide_step",
  description: "Your reaction to the current screen and the ONE action you take next.",
  streamField: "thought",
  schema: {
    type: "object",
    properties: {
      thought: { type: "string", description: "1–2 sentences, first person, present tense: your live reaction to what you see right now." },
      action: { type: "string", enum: ACTIONS },
      target: { type: "integer", description: "Element number, for click / type / select / hover." },
      text: { type: "string", description: "For type: the text to type." },
      option: { type: "string", description: "For select: the visible label of the option to choose." },
      key: { type: "string", enum: KEYS, description: "For press: the key to press." },
    },
    required: ["thought", "action"],
  },
};

const FINDINGS_PROPS = {
  summary: { type: "string", description: "One-sentence verdict." },
  wouldCompleteTask: { type: "string", enum: ["yes", "unsure", "no"] },
  findings: {
    type: "array",
    items: {
      type: "object",
      properties: {
        issue: { type: "string", description: "The specific friction you hit." },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        heuristic: { type: "string", description: "The usability principle it violates." },
        fix: { type: "string", description: "A concrete change that would remove it." },
        steps: { type: "array", items: { type: "integer" }, description: "The step numbers where you hit it (evidence). Empty for a single-screen glance." },
      },
      required: ["issue", "severity", "heuristic", "fix"],
    },
  },
};

const reportTool = (reactionDescription) => ({
  name: "report_findings",
  description: "Your overall reaction and the usability findings from this session.",
  streamField: "reaction",
  schema: {
    type: "object",
    properties: { reaction: { type: "string", description: reactionDescription }, ...FINDINGS_PROPS },
    required: ["reaction", "summary", "wouldCompleteTask", "findings"],
  },
});

const toFindings = (input) => ({
  summary: input.summary,
  wouldCompleteTask: input.wouldCompleteTask,
  findings: Array.isArray(input.findings) ? input.findings : [],
});

const isValidStep = (s) => !!s && ACTIONS.includes(s.action);

// ---- one step of the session ----------------------------------------------
export async function decideStep({ cfg, persona, goal, stepNum, maxSteps, history, elements, omitted = 0, frames = [], screenshotB64, uploadReady, routeContext, onChunk, onRateLimit, abortSignal }) {
  const system = `${persona.description}

You are browsing a real website to accomplish this goal: "${goal}".

Behave like a real, impatient human — NOT a polite assistant. React only to what you
can actually see. If there's no clear path, scroll to look for one, or give up and
bounce. NEVER pretend you succeeded.

The screenshot has numbered red badges on the interactive elements. The list maps each
number to an element. Choose exactly ONE action:
- "click"    + target: click that numbered element
- "type"     + target + text: type into that field (you'll usually click a button or press Enter next)
- "select"   + target + option: choose an option from that dropdown, by its visible label
- "press"    + key: press a key — Enter to submit, Escape to dismiss, Tab to move focus
- "hover"    + target: move the mouse over that element (for menus that open on hover)
- "scroll":  scroll down to see more of the page
- "scrollup": scroll back up if you need to revisit something above
- "back":    go back to the previous page (the browser's back button)
- "wait":    wait for something to finish loading
- "done":    you believe you've accomplished the goal
- "giveup":  you'd abandon this — explain why in your thought
${uploadReady ? `\nIf the page asks you to upload a file or document, a test file is ready: just "click" the upload control (button, link, or drop area) and it attaches automatically — there is no file dialog for you to deal with, and the next screenshot will show it attached.\n` : ""}
Lines in your history marked [TOOL] were failures of the testing tool, not the website.
Don't blame the site for them; just try another way.

Respond with the decide_step tool: your thought first, then the action and its fields.`;

  const elemList =
    elements.map((e) => `[#${e.idx}] ${e.type}: ${e.label}`).join("\n") ||
    "(no interactive elements detected)";
  const more = (omitted > 0 ? `\n(${omitted} less prominent elements on screen aren't numbered.)` : "") +
    (frames.length ? `\n(Embedded content you can see but can't interact with: ${frames.join(", ")}.)` : "");
  const hist = history.length
    ? `What you've done so far:\n${history.map((h, i) => `${i + 1}. ${h}`).join("\n")}\n\n`
    : "";
  const routePrefix = routeContext ? `\nPages visited so far:\n${routeContext}\n\n` : "";
  const userText = `${hist}Step ${stepNum} of ${maxSteps}. ${routePrefix}Interactive elements visible now:\n${elemList}${more}\n\nWhat do you do?`;

  const ask = (extra = "", withStream = true) =>
    chatWithRetry({
      provider: cfg.provider,
      model: cfg.model,
      system,
      parts: [{ image: screenshotB64 }, { text: userText + extra }],
      tool: DECIDE_TOOL,
      // Thinking models (e.g. Gemini 2.5) spend reasoning tokens from this same
      // budget on OpenAI-compatible endpoints — keep headroom above the ~100
      // visible tokens a step actually needs.
      maxTokens: 2000,
      onChunk: withStream ? onChunk : undefined,
      onRateLimit,
      signal: abortSignal,
    });

  logger.log("LLM_START", { step: stepNum, total: maxSteps });
  let { input } = await ask();
  logger.log("LLM_END", { step: stepNum, total: maxSteps });
  if (!isValidStep(input)) {
    // Re-ask once without streaming (the first attempt's thought already printed).
    ({ input } = await ask("\n\nUse the decide_step tool, with an action from the allowed list.", false));
  }
  if (!isValidStep(input)) {
    return { thought: "(couldn't parse my own reaction — bailing)", action: "giveup", target: null, text: null };
  }
  return { ...input, thought: (input.thought || "").trim() || "(no thought)" };
}

// ---- end-of-session structured findings ------------------------------------
// groundTruth: objective facts about the end state (final URL, the --success check) that
// the model should weigh over its own impression.
export async function debrief({ cfg, persona, goal, transcript, outcome, groundTruth, onChunk, onRateLimit, abortSignal }) {
  const system = `${persona.description}

You (${persona.name}) just finished a usability test with this goal: "${goal}".
Session outcome: ${outcome}.

Below is the full transcript — your own thoughts and what happened after each action.
Now step back and report what you learned. Use a researcher's structure, but stay
calibrated to who you are: rate each finding's severity by how badly it hurt THIS
user (your severity rules above), and answer "wouldCompleteTask" for this user —
not for some average visitor.

Every finding must cite the step numbers where you hit it. Results marked [TOOL] were
failures of the testing tool itself, not the website: never report them as findings.
${groundTruth ? `\nObjective ground truth from the page is included at the top of the transcript. If an objective success check is present, let it decide "wouldCompleteTask" rather than your impression.\n` : ""}
Respond with the report_findings tool.`;

  logger.log("LLM_START", { step: "debrief" });
  const { text, input } = await chatWithRetry({
    provider: cfg.provider,
    model: cfg.model,
    system,
    parts: [{ text: groundTruth ? `${groundTruth}\n\n--- transcript ---\n${transcript}` : transcript }],
    tool: reportTool("2–3 sentences of your raw overall reaction as this user — plain prose, first person."),
    signal: abortSignal,
    // Generous: reasoning tokens (thinking models) + the full findings JSON both
    // draw from this budget; 2500 was observed truncating mid-JSON on gemini-2.5.
    maxTokens: 8000,
    onChunk,
    onRateLimit,
  });
  logger.log("LLM_END", { step: "debrief" });
  if (!input || !input.summary) {
    return { summary: "(couldn't parse findings)", wouldCompleteTask: "unsure", findings: [], _raw: text };
  }
  return toFindings(input);
}

// ---- single-screenshot first impression (--glance) -------------------------
export async function glance({ cfg, persona, goal, screenshotB64, fullPage, onChunk, onRateLimit, abortSignal }) {
  const system = `${persona.description}

You're using a website with this goal: "${goal}". You're shown a screenshot of the
page${fullPage ? " (the full scrollable page)" : " exactly as it first loads"}.

React like a real, impatient human, not a polite assistant. Respond only to what's
visible, hesitate when the path is unclear (that's a finding), and be quick to blame
the interface. Don't be generous.

Respond with the report_findings tool: your live reactions first, then the findings.`;

  logger.log("LLM_START", { step: "glance" });
  const { text, input } = await chatWithRetry({
    provider: cfg.provider,
    model: cfg.model,
    system,
    parts: [{ image: screenshotB64 }, { text: "This is the page. Go." }],
    tool: reportTool("2–4 short paragraphs, first person, present tense — your live reactions toward your goal."),
    maxTokens: 8000, // same reasoning-token headroom as debrief
    onChunk,
    onRateLimit,
    signal: abortSignal,
  });
  return {
    narration: (input?.reaction || "").trim(),
    findings: input?.summary ? toFindings(input) : null,
    rawFindings: input ? JSON.stringify(input, null, 2) : (text || "").trim(),
  };
}
