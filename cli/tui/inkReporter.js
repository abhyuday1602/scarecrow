// cli/tui/inkReporter.js — a reporter (same interface as cli/reporter.js) that records
// run events into a plain "model" object and calls bump() so the Ink tree re-renders.
// <RunView> reads the model. Nothing here writes to stdout — that's the whole point
// under Ink, where stray writes would corrupt the React-managed screen.

export function newRunModel(mode) {
  return {
    mode,
    header: null,
    phase: null,            // current spinner label, or null
    steps: [],              // walkthrough: { n, total, thought, action, result }
    debrief: null,          // { text }
    narration: "",          // glance "looking" stream
    narrationActive: false,
    findings: null,
    rawFindings: null,
    objective: null,        // { marker, passed }
    outcome: null,
    runDir: null,
    artifacts: [],          // dim note lines ("findings written to …")
    summary: null,          // data for <Summary>
    cancelled: false,
    error: null,
    done: false,
  };
}

export function makeInkReporter(model, bump) {
  const last = () => model.steps[model.steps.length - 1];

  // A streamer that shows a spinner labelled `label` until the first token, then appends
  // tokens via onChunk — mirroring cli/ui.js streamPrinter, but into the model.
  const stream = (label, onChunk) => {
    model.phase = label; bump();
    return {
      chunk: (t) => { if (!t) return; model.phase = null; onChunk(t); bump(); },
      end: () => { if (model.phase === label) model.phase = null; bump(); },
    };
  };

  return {
    start({ inputs }) {
      model.header = {
        personaName: inputs.persona.name,
        personaKey: inputs.personaKey,
        task: inputs.task,
        url: inputs.url,
        provider: inputs.cfg.provider,
        model: inputs.cfg.model,
      };
      bump();
    },
    phase(label) {
      model.phase = label; bump();
      return () => { if (model.phase === label) { model.phase = null; bump(); } };
    },
    step(n, total) {
      model.steps.push({ n, total, thought: "", action: null, result: null });
      model.phase = null; bump();
    },
    thinking() { return stream("Thinking …", (t) => { const s = last(); if (s) s.thought += t; }); },
    // The persona navigates as it goes; keep the header's URL pointed at the live page
    // rather than the one the run started on.
    currentUrl(url) { if (url && model.header) { model.header.url = url; bump(); } },
    action(desc) { const s = last(); if (s) s.action = desc; bump(); },
    result(text) { const s = last(); if (s) s.result = text; bump(); },
    sessionEnded(outcome, runDir) { model.outcome = outcome; model.runDir = runDir; model.phase = null; bump(); },
    debriefHeading() { model.debrief = { text: "" }; bump(); },
    reflecting() { return stream("Reflecting …", (t) => { if (model.debrief) model.debrief.text += t; }); },
    thinkingOutLoudHeading() { model.narrationActive = true; bump(); },
    looking() { return stream("Looking …", (t) => { model.narration += t; }); },
    findings(obj) { model.findings = obj; bump(); },
    rawFindings(text) { model.rawFindings = text; bump(); },
    objectiveCheck(assertion) { model.objective = assertion; bump(); },
    a11y(results) { if (results?.violations) { model.a11y = results; bump(); } },
    artifacts(lines) { model.artifacts = lines; bump(); },
    summary(data) { model.summary = data; bump(); },
    json() { /* no machine output in the TUI */ },
    async rateLimitWait({ waitMs, attempt, maxRetries }) {
      const end = Date.now() + waitMs;
      const tick = () => {
        const s = Math.max(0, Math.ceil((end - Date.now()) / 1000));
        model.phase = `rate limited — retrying in ${s}s (${attempt}/${maxRetries})`;
        bump();
      };
      tick();
      const interval = setInterval(tick, 1000);
      await new Promise((r) => setTimeout(r, waitMs));
      clearInterval(interval);
      model.phase = "Thinking…";
      bump();
    },
  };
}
