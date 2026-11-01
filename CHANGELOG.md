# Changelog

## Unreleased

### Changed
- **Features that didn't work end to end now say "coming soon" instead of silently doing nothing**: video recording (`--record`, `/record`), the accessibility audit (`--a11y`, `/a11y`, which only ever audited the first page), `crow resume` (which only rebuilt a start-over command), and the TUI's `/device` (the CLI's `--device` still works). Each prints a clear notice and is listed under "Coming soon" in the README.
- **Model replies are structured.** Every call fills in a tool or JSON-schema object instead of prose with a JSON blob on the end, so the action, findings and verdict are never pulled out of free text with a regex. A thought containing `{` used to break parsing. The persona's thoughts still stream live, read out of the structured reply as it arrives.
- **New actions:** `select` (a dropdown option, by label), `press` (Enter, Escape, Tab, arrow keys), `hover`, and `back`. `type` now sends real keystrokes, so key handlers and input masks fire; `fill()` skipped them and couldn't operate a `<select>` at all.
- **Element numbering is much less lossy.** Elements covered by something else (a cookie banner, a modal) are no longer numbered. When a clickable card wraps a real button, the button is numbered rather than the card. Elements are ranked by prominence instead of DOM order, so a dense nav can't use up the budget before the main call to action (and the model is told how many weren't numbered). Labels use the accessible name. Open shadow roots and same-origin iframes are searched too.
- **Clean screenshots.** The numbered badges are only on screen for the screenshot the model picks from (`step-NN.marked.png`). The report's screenshots (`step-NN.png`) are clean, so a persona never critiques a page covered in red markers.
- **One retry layer.** The SDKs' own retries are off. Rate limits, 5xx/overloaded responses, timeouts and dropped connections are retried in one place, up to 5 attempts, with a visible countdown that says why. Before, the SDK's silent retries stacked under ours: about 30 requests for one rate-limited step, with a 2-minute timeout each.
- **`--success` is richer and decides the verdict.** It accepts `text:`, `text:/regex/`, `url:`, `url:/regex/` and `selector:<css>`. A bare value still matches the page text or the URL, but the text has to be a whole word now. When given, it decides task completion for `--ci`, the JUnit export and the HTML report, instead of only being a hint to the model.
- **Findings cite evidence.** Each finding lists the steps it happened at, and `report.md` links them to the screenshots.
- **Tool failures are separated from site friction.** Actions that fail for automation reasons are marked `[TOOL]`, counted in `report.md` and `findings.json`, and kept out of the findings.
- `localhost:3000`, `127.0.0.1:…`, private-network IPs and `*.local`/`*.test` hosts now default to `http://` instead of `https://`, which made the main use case, a local dev server, fail with an SSL error.
- **Run it with `npx github:abhyuday1602/scarecrow`**, straight from GitHub, with no clone and no npm registry publish (`npm install -g github:abhyuday1602/scarecrow` for a permanent `crow`). The registry package isn't published yet; the README leads with the GitHub command and keeps install-from-source for development.
- The "install the browser" hints (`doctor`, onboarding, errors) now print `npx playwright@<our version> install chromium`. A bare `npx playwright` has no local Playwright to find under an npx install, so it fetched the latest from the registry, which can install a Chromium revision ours can't launch.

### Fixed
- **The first-run setup wizard crashed before it started.** `onboarding.js` imported `installBrowser`, which `browser-setup.js` never exported, so running `crow` with no arguments on a machine without Chromium or an API key died with a module link error. That's the first thing every new `npx` user hits.
- **Token counts were missing for Gemini, Groq and Ollama.** Streamed OpenAI-compatible calls never asked for usage (`stream_options.include_usage`), so every step logged `?`. The finish reason was also hardcoded to `stop`; both are now read from the response.
- **A pasted API key didn't take effect until restart.** SDK clients were cached with the key they were created with; they're now rebuilt when the key changes.
- **Batch `--ci` passed if the last run passed**, even when earlier runs failed. The batch now fails if any run failed or errored.
- **The JUnit export put several `<failure>`s in one testcase and reported more failures than tests.** It now has one testcase for task completion plus one per high-severity finding, using the same pass/fail rule as `--ci`.
- **A saved model was sent to whatever provider you picked**, so `--provider gemini` with a saved Claude model asked Gemini for `claude-…`. A saved or `MODEL` model now only applies to the provider it was saved with.
- **Flags before the subcommand broke it**: `crow -p skeptic glance x.com` said `Unknown command "glance"`.
- **Stopping a TUI run ended it as an error.** Stopping aborts the in-flight model call, and the run reported that as a failure; it's now a clean cancel.
- **The TUI's `/rerun` picker never found any sessions**; it looked in `./runs` instead of the config directory.
- **Every run after the first in one process (TUI, batch) logged into the first run's log file.**
- **The link-local block could be bypassed** with `http://[::ffff:169.254.169.254]/`, a DNS name pointing there, or any link or redirect after the first page. Every request the page makes is now checked, with hostnames resolved first.
- **Declining the Ollama setup printed "Aborting" and then carried on**, launching the browser against a model that couldn't answer. It now stops the run.
- "Add more steps?" had no limit; extensions now stop at the 100-step cap, in the TUI too. The run also no longer changes `inputs.steps` mid-run.
- The browser install used `npx playwright`, which could install a Chromium build our Playwright can't launch; it now runs the bundled Playwright CLI.
- `crow diff` gave an improved/regressed verdict for runs of different sites, personas or goals; it now says they're not comparable.
- A corrupt `session-state.json` could turn a finished run into an error and overwrite its findings.
- `withTimeout` left its timer running after a fast call.
- The README overstated `--log-responses`; it logs the start of each prompt and response, not the full text.
- **TUI screen corruption, and how it was found.** The interactive mode would intermittently render garbled or overlapping text when a run finished or a picker opened. It reproduced reliably in a scripted pty harness (`ptyprocess` + `pyte`) that captures what a real terminal shows. The cause was Ink's layout: an ever-growing `justifyContent: "flex-end"` + `overflow: "hidden"` transcript box occasionally made Yoga give sibling rows overlapping positions, and Ink's writer stamps characters without clearing, so fragments of both rows remained. Committed transcript lines now render through `<Static>`, which prints each one once and removes it from later layout passes, so past output also lives in the terminal's real scrollback. The root frame had been pinned to the terminal height to dodge a different Ink quirk, and with `<Static>` that pin made Ink reprint the whole transcript on every keystroke, so it was removed. The live part of the screen (a running step, a picker) is now kept shorter than the terminal; `/clear` actually clears, including Ink's own replay buffer; and short notices like "Press Ctrl+C again to exit" no longer pile up in scrollback.

### Added
- Engine tests: browser tests against fixture pages (a cookie banner over the CTA, a card wrapping a button, a dropdown form, Enter-to-submit search, a hover menu, shadow DOM, a same-origin iframe, a dense nav), and end-to-end run-loop tests with model replies replayed from a cassette (`SCARECROW_LLM_CASSETTE`, `SCARECROW_LLM_MODE=record|replay`), with no API key or network calls. CI installs Chromium so they run there too.
- `SECURITY.md`, issue templates (bug, feature, persona) and a pull request template.
- A release workflow that publishes to npm with provenance when a version tag is pushed.

## 0.2.0 — 2026-08-09

### Changed
- **Node.js 20.19+ (or 22.13+) is now required**, up from 18+. The old floor was never actually true: `playwright` (at `^1.61.0`, which resolves to 1.62.x) needs Node 20, `vitest` 4.x cannot start on Node 18 at all, and `eslint` 10 / `vite` / `rolldown` all require `^20.19.0 || ^22.13.0 || >=24`. `engines.node` now states that range exactly, so `npm install` warns accurately instead of silently under-specifying.
- **Licensed under Apache 2.0** instead of MIT.
- Refreshed the suggested Anthropic models in the `/model` picker — dropped `claude-opus-4-1` (deprecated, retiring 2026-08-05) and `claude-3-5-sonnet-latest` (no longer a valid alias; its snapshots retired 2025-10-28), added `claude-opus-5` and `claude-sonnet-5`. The default model (`claude-sonnet-4-6`) is unchanged.
- CI now tests Node 20.x, 22.x, and 24.x; the 18.x job was removed since the toolchain can no longer run there.

### Added
- **A clear error when the Node version is unsupported.** `npm` only warns on an `engines` mismatch, so an old runtime installs fine and then fails later inside Playwright — an error naming a dependency the user never installed. Scarecrow now checks up front and says which range it needs and which version you're on. `--version` and `--help` still work, so you can read your own version when filing a bug. The range is parsed from `package.json`'s `engines` field rather than duplicated, so the two can't drift.

### Fixed
- **A run that hit its step limit non-interactively crashed instead of finishing.** When the step budget ran out, Scarecrow asked "add more steps?" — even under `--yes`, `--json`, or a piped stdout, where nothing can answer. The prompt threw, aborting the session *before* the debrief, so the run exited 1 and wrote `"outcome": "error"` with `findings: []`, discarding every model call it had already paid for. This broke the two automation paths the README advertises (`--yes` and `--ci`) and any invocation whose output was redirected. The question is now skipped when nobody can answer it: the run ends normally on "ran out of steps", produces its debrief and findings, and prints a one-line note about the limit.
- **The TUI's `/provider` key-paste flow wrote your API key into the package install directory** — the same bug fixed for `crow init` below, missed in the TUI. For a global install that path is inside `node_modules`, so the key either failed to save with `EACCES` or was silently wiped on the next upgrade. It now writes to `~/.config/scarecrow/.env` (mode 600), matching `crow init` and the onboarding wizard, and reports the full path it saved to.
- The step header showed the URL the run started on rather than the page the persona had navigated to, so every step still read `example.com` after it had clicked through elsewhere.
- Artifact paths were printed with a `./` prefix even though runs default to an absolute path under `~/.config/scarecrow/`, producing un-copy-pasteable output like `.//home/you/.config/...`.
- `crow glance` streamed the raw `<think-aloud>` markers to the terminal while the narration arrived. They were already stripped from the saved report; now they're stripped from the live stream too.
- `.env.example` is now actually published. `crow init` reads it as the `.env` template, but it was missing from `package.json`'s `files`, so installed users always got the thinner built-in fallback instead.
- **`crow init` no longer writes into the package install directory.** It scaffolded `.env` and `uploads/` next to `index.js`, which for a global install is inside `node_modules` — typically root-owned (so the write failed with `EACCES`) and wiped on every upgrade. `.env` now goes to `~/.config/scarecrow/`, matching where the interactive onboarding already wrote and where it was already being read from; one key then covers every project, and it can't be dropped into a repo by accident. `uploads/` instead lands in the directory you run `init` from, since test fixtures belong beside the site they're for — and `--upload` prefers that local folder, falling back to `~/.config/scarecrow/uploads`. The new folder is seeded with a README explaining bare-filename usage and the "must be inside uploads/" rule, which installed users previously had no way to see.
- `crow doctor` now checks your Node version against `package.json`'s `engines` range instead of a hardcoded `>=18`, and points at `crow init` when no uploads folder is found (nothing creates one on demand any more).
- Corrected the documented location of run artifacts. Output has defaulted to `~/.config/scarecrow/runs/` since the XDG move, but the docs still described a project-local `./runs/`, so the `export`/`resume`/`diff` examples were not copy-pasteable.
- Patched three high-severity advisories in transitive dev dependencies (`brace-expansion` via `eslint`, `nanoid` and `postcss` via `vitest`/`vite`). All were dev-only — `npm audit --omit=dev` reported zero — so the published `crow` runtime was never affected.
- **`--upload <file>` (space-separated) silently attached your entire `uploads/` folder instead of the named file.** The flag only ever consumed an inline `--upload=<file>` value; the space form left `upload` as bare `true` and discarded the filename as a stray positional, so every file in `uploads/` got attached — and the path-traversal guard, which only runs on the string form, was never reached. Both forms now parse identically.
- **A page that failed to load (bad domain, refused connection, dead server) produced a confident report anyway, with exit 0.** Navigation errors were swallowed so the agent would proceed against Chrome's blank error page and the model would invent findings about it. A `goto()` timeout (a page that legitimately never fires `load`) is unaffected and still proceeds as before; a genuine navigation failure now stops the run with a clear message and exit 1 instead.
- **`--record` never produced the `recording.webm` it documents.** Playwright only resolves the video path when the browser context closes, which happened in the run's `finally` — long after the code that renames the file had already run and found nothing. The result was a raw `page@<hash>.webm` left in the run directory, no "video written to…" line, and no mention in the saved-artifacts list, so `--record` looked like it had silently failed. The session now closes before writing artifacts, and if no video was produced it says so rather than staying silent.
- **`--a11y` results were saved but never shown.** The audit ran and its violations landed in `findings.json`, but the terminal showed only a spinner and then moved on, so an accessibility run appeared to do nothing. Runs now print a violation tally and the worst few (`crow diff` already reported these counts; the run itself was the only place they were invisible).
- **`crow resume` suggested a re-run command that changed the run's behaviour.** The saved `upload` field is the resolved list of files, and an empty list is still truthy in JavaScript, so *every* reconstructed command had a bare `--upload` appended — which means "attach everything in `uploads/`". Copy-pasting the tool's own suggestion could therefore upload files the original run never touched. Runs without uploads now omit the flag, and runs with them name the exact files.
- **`--steps 0` silently ran the full default of 8 steps**, and negative values produced two misleading errors (`-n expects a value`, then `unknown option "-5" — did you mean "--ci"?`). `Number(0)` is falsy, so the `|| 8` fallback fired on a legitimate value. Step counts are now validated and rejected with a single clear message, and `--steps` is capped at 100 — each step is roughly one vision API call, so a mistyped `-n 888` was previously a ~900-call bill with no warning.
- **`crow export --format pdf` wrote JSON and reported success.** The format switch treated every unrecognized value as `json`. Unsupported formats are now rejected up front, naming the ones that work.
- **The plain CLI was hardcoded to 60 columns**, so on a narrower terminal every rule and panel border wrapped onto a ragged second line. Layout now shrinks to fit (unchanged at 60 columns and above), long step headers are truncated rather than wrapped, and the rate-limit countdown erases its own full width instead of a fixed 60 characters, which used to leave residue behind longer status lines.
- **Ctrl+C during a run printed nothing at all** — output just stopped mid-action, which reads like a crash, with no hint that the browser was still being closed. It now says what's happening (on stderr, so `--json` output stays parseable). The TUI's status bar also advertised `^C quit` when quitting actually requires a double press; it now says so.

## 0.1.0 — 2026-07-08

First public release.

- `crow <url>` runs a full click-through: a persona works toward a goal in a real
  Playwright browser, choosing from numbered elements on each screenshot, then writes a
  debrief with findings, severity and suggested fixes.
- `crow glance` gives a single-screenshot first impression, with `--full` for the whole page.
- Built-in personas, plus custom ones from the TUI's `/persona-add` wizard.
- Anthropic, Gemini and Groq providers, with streaming output and rate-limit retries.
- An interactive TUI (`crow` with no arguments) with slash commands, themes and an inline guided setup.
- `crow init`, `crow doctor`, `crow config`, `crow personas`, `crow export` (HTML, JUnit,
  JSON), `crow diff` and `crow resume`.
- `--upload` attaches files from `uploads/`, but only to file pickers that the agent's own
  click opened.
- Run artifacts: a screenshot per step, `findings.json` and `report.md`.
