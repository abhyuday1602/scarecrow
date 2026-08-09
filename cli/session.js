// cli/session.js — the two run modes: runSession (the click-through) and runGlance
// (one first impression). The orchestration here (browser actions, model calls, building
// the transcript, writing artifacts) is unchanged; what moved out is *presentation*.
//
// Neither function writes to stdout directly anymore — they drive an injected `reporter`
// (see cli/reporter.js). The default reporter reproduces the original terminal output
// exactly, so the plain CLI is byte-for-byte the same; the Ink TUI passes its own
// reporter to render the same events as React state.
//
// Both accept an optional `shouldStop()` for cooperative cancellation: it's checked at
// each step boundary, so a TUI can stop a run cleanly (the browser is always closed in
// the `finally`). Cancellation takes effect at the next step boundary, not mid-action.

import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Session } from "../browser.js";
import { decideStep, debrief, glance } from "../agent.js";
import { describe, buildReport } from "./render.js";
import { makeTerminalReporter } from "./reporter.js";
import { saveSessionState, markSessionComplete } from "./resume.js";
import { logger, setLogDir, setLogResponses } from "./logger.js";
import { configDir, ensureDir } from "./paths.js";
import { registerCleanup } from "./cleanup.js";

const defaultReporter = (inputs) =>
  makeTerminalReporter({ quiet: inputs.quiet, json: inputs.json, yes: inputs.yes });

// --- glance mode ------------------------------------------------------------
export async function runGlance(inputs, { version, reporter, shouldStop: _shouldStop, abortSignal } = {}) {
  const rep = reporter || defaultReporter(inputs);
  setLogResponses(inputs.logResponses !== false);

  const session = new Session({ headed: inputs.headed, uploadFiles: inputs.upload, device: inputs.device });
  await session.start();
  // Fallback if a SIGINT/SIGTERM/crash arrives before the `finally` below runs (e.g. while
  // still awaiting the LLM). cli/cleanup.js owns the actual process.exit() call now.
  const unregister = registerCleanup(() => session.close());
  try {
    let stop = rep.phase(`Loading ${  inputs.url  } …`);
    await session.open(inputs.url);
    stop();

    let b64;
    if (inputs.full) {
      stop = rep.phase("Capturing full page …");
      const buf = await session.page.screenshot({ type: "png", fullPage: true });
      b64 = buf.toString("base64");
      stop();
    } else {
      stop = rep.phase("Taking screenshot …");
      b64 = await session.shot();
      stop();
    }

    rep.start({ version, inputs });
    rep.thinkingOutLoudHeading();
    const printer = rep.looking();

    const { narration, findings, rawFindings } = await glance({
      cfg: inputs.cfg,
      persona: inputs.persona,
      goal: inputs.task,
      screenshotB64: b64,
      fullPage: inputs.full,
      onChunk: printer.chunk,
      onRateLimit: rep.rateLimitWait,
      abortSignal,
    });
    printer.end();

    // In --json mode this is the only output; otherwise it's a no-op and the pretty
    // findings/summary below print instead.
    rep.json({
      url: inputs.url, provider: inputs.cfg.provider, model: inputs.cfg.model,
      persona: inputs.personaKey, goal: inputs.task, mode: "glance",
      timestamp: new Date().toISOString(),
      narration, ...(findings || {}),
    });

    if (findings) rep.findings(findings);
    else rep.rawFindings(rawFindings);
    rep.summary({ findings, outcome: "glance critique" });

    return { findings, narration };
  } finally {
    unregister();
    await session.close();
  }
}

// --- session (click-through) mode -------------------------------------------
export async function runSession(inputs, { version, reporter, shouldStop, abortSignal, onOutOfSteps: extOnOutOfSteps } = {}) {
  const rep = reporter || defaultReporter(inputs);
  const onOutOfSteps = extOnOutOfSteps || rep.onOutOfSteps;
  setLogResponses(inputs.logResponses !== false);

  const runDir = join(inputs.out || join(configDir(), "runs"), new Date().toISOString().replace(/[:.]/g, "-"));
  ensureDir(runDir);
  setLogDir(runDir);

  const session = new Session({
    headed: inputs.headed,
    uploadFiles: inputs.upload,
    device: inputs.device,
    record: inputs.record,
  });
  if (inputs.record) {
    session.setRecordDir(runDir);
  }
  await session.start();

  // Fallback if a SIGINT/SIGTERM/crash arrives before the `finally` below runs (e.g. mid
  // step, while awaiting the LLM or a page action). cli/cleanup.js owns the process.exit().
  const unregister = registerCleanup(() => session.close());

  // Closing is what makes Playwright resolve session.videoPath, so --record needs the
  // close to happen *before* the artifact block rather than in the `finally`. Guarded so
  // the `finally` can call it again unconditionally without double-closing.
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    unregister();
    await session.close();
  };

  const history = [];      // short lines fed back to the model each step
  const transcript = [];   // full thoughts + outcomes for the debrief
  const steps = [];        // structured per-step record for the Markdown report
  let outcome = "ran out of steps";
  let cancelled = false;

  // Objective goal check: a substring to look for in the URL or visible page text.
  const successMarker = inputs.success;
  let successHit = false;
  const checkSuccess = async () => {
    if (!successMarker || successHit) return;
    if (
      session.url().toLowerCase().includes(successMarker.toLowerCase()) ||
      (await session.hasText(successMarker))
    ) successHit = true;
  };

  try {
    let stop = rep.phase(`Loading ${  inputs.url  } …`);
    await session.open(inputs.url);
    stop();

    // Run accessibility audit if enabled
    let a11yResults = null;
    if (inputs.a11y) {
      stop = rep.phase("Running accessibility audit …");
      a11yResults = await session.auditA11y();
      stop();
    }

    rep.start({ version, inputs });
    logger.log("START", { url: inputs.url, persona: inputs.personaKey, task: inputs.task, provider: inputs.cfg.provider, model: inputs.cfg.model, steps: inputs.steps, mode: inputs.glance ? "glance" : "session" });

    let totalSteps = inputs.steps;
    let step = 1;
    while (step <= totalSteps) {
      if (shouldStop?.()) { cancelled = true; outcome = "cancelled"; logger.log("CANCEL", { step }); break; }

      stop = rep.phase("Reading the page …");
      const elements = await session.annotate();
      const b64 = await session.shot();
      const stepPad = String(totalSteps).length;
      const shotName = `step-${String(step).padStart(stepPad, "0")}.png`;
      await session.saveShot(join(runDir, shotName));
      stop();

      // Header first; the spinner then covers model latency until the first token.
      rep.step(step, totalSteps);
      rep.currentUrl?.(session.url());
      const printer = rep.thinking();

      const action = await decideStep({
        cfg: inputs.cfg,
        persona: inputs.persona,
        goal: inputs.task,
        stepNum: step,
        maxSteps: totalSteps,
        history,
        elements,
        screenshotB64: b64,
        uploadReady: inputs.upload.length > 0,
        routeContext: session.getRouteContext(),
        onChunk: printer.chunk,
        onRateLimit: rep.rateLimitWait,
        signal: abortSignal,
      });

      printer.end();
      rep.action(describe(action));
      logger.log("STEP_START", { step, total: totalSteps, action: action.action, target: action.target, thought: action.thought });

      if (action.action === "done") {
        outcome = "reached the goal";
        logger.log("COMPLETE", { outcome, step });
        transcript.push(`Step ${step}: ${action.thought} [DONE]`);
        steps.push({ n: step, shot: shotName, thought: action.thought, action: describe(action), result: null });
        break;
      }
      if (action.action === "giveup") {
        outcome = "gave up / bounced";
        logger.log("COMPLETE", { outcome, step });
        transcript.push(`Step ${step}: ${action.thought} [GAVE UP]`);
        steps.push({ n: step, shot: shotName, thought: action.thought, action: describe(action), result: null });
        break;
      }

      // Stop before acting if the user cancelled while the model was thinking.
      if (shouldStop?.()) { cancelled = true; outcome = "cancelled"; logger.log("CANCEL", { step }); break; }

      stop = rep.phase("Acting …");
      // The model's target indexes the annotated element list and ends up inside a
      // CSS selector — accept only a non-negative integer, otherwise skip the action.
      let res;
      if (action.target !== undefined && (!Number.isInteger(Number(action.target)) || Number(action.target) < 0)) {
        res = `Skipped: invalid target "${action.target}" (expected an element number).`;
      } else {
        if (action.target !== undefined) action.target = Number(action.target);
        res = await session.act(action);
      }
      stop();

      // Fold in any file-upload outcome the picker handler recorded during this action.
      const up = session.drainUploads();
      const resFull = up ? `${res} ${up}` : res;

      rep.result(resFull);
      logger.log("STEP_END", { step, total: totalSteps, result: resFull });

      // Observation delay between steps: pause 2s so the user sees what happened.
      // This is NOT a step — the step counter is unchanged.
      if (step < totalSteps) {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (shouldStop?.()) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      history.push(`${describe(action)} → ${resFull}`);
      transcript.push(`Step ${step}: ${action.thought}\n  action: ${describe(action)}\n  result: ${resFull}`);
      steps.push({ n: step, shot: shotName, thought: action.thought, action: describe(action), result: resFull });
      await checkSuccess();

      // Save session state for potential resume. cfg holds a live client and is
      // dropped; provider/model are lifted out of it so re-run can recover them.
      saveSessionState(runDir, {
        inputs: { ...inputs, cfg: undefined, provider: inputs.cfg.provider, model: inputs.cfg.model },
        history,
        steps,
        currentStep: step,
        outcome,
      });

      step++;

      // If we ran out of steps, ask the user if they want to continue.
      if (step > totalSteps && outcome === "ran out of steps" && onOutOfSteps) {
        const res = await onOutOfSteps({ step: step - 1, totalSteps, history });
        if (res?.extraSteps) {
          totalSteps += res.extraSteps;
          inputs.steps = totalSteps;
          logger.log("EXTEND_STEPS", { extra: res.extraSteps, newMax: totalSteps });
        }
      }
    }

    const finalUrl = session.url();
    await checkSuccess();
    const assertion = successMarker ? { marker: successMarker, passed: successHit } : null;
    const signal =
      `Final URL: ${finalUrl}${ 
      assertion
        ? `\nObjective success check: the marker "${assertion.marker}" was ${
            assertion.passed ? "FOUND" : "NOT found"
          } in the final URL or page text.`
        : ""}`;

    rep.sessionEnded(outcome, runDir);

    // On a user cancel we stop here: per-step screenshots are already on disk, but we
    // skip the (costly) debrief and the findings/report artifacts.
    if (cancelled) return { cancelled: true, outcome, runDir };

    rep.debriefHeading();
    const debriefPrinter = rep.reflecting();
    let reflection = ""; // captured for report.md even when not shown

    const findings = await debrief({
      cfg: inputs.cfg,
      persona: inputs.persona,
      goal: inputs.task,
      transcript: transcript.join("\n\n"),
      outcome,
      signal,
      onChunk: (t) => { reflection += t; debriefPrinter.chunk(t); },
      onRateLimit: rep.rateLimitWait,
      abortSignal,
    });

    debriefPrinter.end();
    rep.findings(findings);
    rep.objectiveCheck(assertion);
    rep.a11y?.(a11yResults);

    const report = {
      url: inputs.url,
      timestamp: new Date().toISOString(),
      provider: inputs.cfg.provider,
      model: inputs.cfg.model,
      persona: inputs.personaKey,
      goal: inputs.task,
      mode: "session",
      outcome,
      finalUrl,
      assertion,
      a11y: a11yResults,
      routeHistory: session.getRouteHistory(),
      ...(findings || {}),
    };
    // Everything above reads live browser state; from here on it's just files. Close now
    // so session.videoPath is resolved in time for the --record block below.
    await finish();

    const outPath = join(runDir, "findings.json");
    writeFileSync(outPath, JSON.stringify(report, null, 2));

    const mdPath = join(runDir, "report.md");
    writeFileSync(
      mdPath,
      buildReport({ inputs, outcome, finalUrl, assertion, steps, reflection: reflection.trim(), findings })
    );
    // No "./" prefix: runDir defaults to an absolute path under the XDG config dir, so
    // prefixing produced paths like ".//home/you/.config/..." that don't copy-paste.
    const artifactFiles = [outPath, mdPath];
    rep.artifacts([`findings written to ${outPath}`, `report written to ${mdPath}`]);

    // Handle video recording. Playwright names the file after an internal page id, so
    // rename it to something predictable — and always say something, since silence after
    // an explicit --record reads as "recording failed".
    if (inputs.record) {
      const videoDest = join(runDir, "recording.webm");
      let saved = false;
      if (session.videoPath) {
        try {
          renameSync(session.videoPath, videoDest);
          artifactFiles.push(videoDest);
          rep.artifacts([`video written to ${videoDest}`]);
          saved = true;
        } catch { /* fall through to the notice below */ }
      }
      if (!saved) rep.artifacts(["video not saved — the page may have closed before anything was recorded"]);
    }

    rep.summary({ findings, outcome, assertion, files: artifactFiles });
    rep.json(report);

    // Mark session as complete so it doesn't show as "interrupted"
    markSessionComplete(runDir);

    return { findings, outcome, runDir };
  } catch (err) {
    logger.log("ERROR", { message: err?.message || String(err) });
    // Write partial artifacts before re-throwing
    const partialReport = {
      url: inputs.url,
      timestamp: new Date().toISOString(),
      provider: inputs.cfg.provider,
      model: inputs.cfg.model,
      persona: inputs.personaKey,
      goal: inputs.task,
      mode: "session",
      outcome: "error",
      finalUrl: session.url(),
      assertion: null,
      a11y: null,
      routeHistory: session.getRouteHistory(),
      error: err?.message || String(err),
      findings: [],
    };
    try {
      writeFileSync(join(runDir, "findings.json"), JSON.stringify(partialReport, null, 2));
      writeFileSync(join(runDir, "report.md"),
        buildReport({ inputs, outcome: "error", finalUrl: session.url(), assertion: null, steps, reflection: "", findings: null }));
    } catch { /* best effort */ }
    throw err;
  } finally {
    await finish();
  }
}
