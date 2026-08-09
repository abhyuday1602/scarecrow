# Changelog

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

### Summary
- First public release
- 119/119 tests passing, ESLint clean, `npm audit` 0
- Full feature set including AI-powered synthetic user testing, AI headless runs, TUI mode, automated screenshots, commentary transcription, AI-driven Test("Scrolling"...)

### Major Features
**Core Capabilities**

- **Click-through sessions** — AI-driven persona walks through your site toward a goal, clicking and typing like a real user
- **Glance mode** — fast, oneshot usability critique for quick validation
- **Real-time streaming** — show AI reasoning and output live in terminal without blocking
- **TUI** (Text User Interface) — full-screen, Claude Code-style REPL with live viewing
- **Personas** — 5 built-in AI user profiles (novice, power, skeptic, rushed, access) with second‑person goal descriptions, plus unlimited custom ones
- **Device emulation** — test on desktop, tablet, or mobile viewport presets
- **Upload testing** — `--upload` flag lets personas complete file‑upload flows
- **Interactive guided mode** — CLI wizard for first‑time setup

**Lifecycle & Session Management**

- **Session persistence** — resume interrupted runs; store `./runs/<ts>/results`
- **Session comparison** — `crow diff` side‑by‑side diff of two runs
- **Batch testing** — `--batch <json>` for automated multi‑scenario runs
- **Video recording** — optional `--record` saves session as `./runs/<ts>/recording.webm`
- **Accessibility** — built‑in WCAG audit (`--a11y`) with violation listing

**Provider Flexibility**

- **Multiple LLMs** — native OpenAI‑compatible clients (Anthropic, Gemini, Groq)
- **Live model listing** — fetch current models per provider via `/provider` picker
- **Ollama** — local, key‑less deployment with integrated daemon control (`/ollama` commands)

**Theming**

- **9 curated themes** (cursor, discord, claude, tokyo, catppuccin, gruvbox, ocean, rose, gotham)
- **Full‑screen background** — OSC 11 terminal background painting for immersive theme switching
- **Live picker preview** — see theme changes instantly, cancel/accept as needed

**Smart UI**

- **Spinner animation** — brain‑friendly loading indicators (braille spinner in TTY, plain line in CI)
- **Streaming printer** — spinner clears on first token; dimmed, flowing prose
- **Status footer** — concise context (mode/provider/persona/urlhost + actionable hints)
- **Slash commands** — `/help`, `/commands`, `/persona`, `/provider`, `/theme`, `/resume`, `/clear` etc.
- **Inline pickers** — persona/provider/theme/resume pickers right above the input box (no mode swaps)
- **Guided collect** — focused field entry with live context and CONFIRM step

**Quality & Reliability**

- **854 lines of tests** across 9 files — 119 passed, 0 failures
- **ESLint** with style guardrails (60 rules, custom per‑context globals)
- **Security hardening** — env‑var allowlist, masked key input, XSS‑safe HTML export
- **Git hygiene** — `uploads/` and PII tests ignored, 0 secrets in history
- **Production‑ready packaging** — `bin: crow`, `files:` allowlist, `publishConfig: public`

### Notable Backlog Items
- Scope for future `--upload-mode=queue` (per‑picker file consumption)
- Session reuse via `storageState` to avoid password prompts
- Domain allowlist / off‑domain navigation guard
- `--redact` / transcript scrubbing utilities
- Per‑field file mapping (route specific files to specific controls)
- Drag‑and‑drop support via synthetic `DataTransfer`
- Generating throwaway fixture files on the fly (`--upload=auto:pdf`)

### Implementation Highlights

#### TUI Architecture
- Single‑scroll transcript (`<Static>`), fixed input + status footer
- **No mode swaps** — every control in one continuous flow (Claude Code feel)
- Input ownership limited to **Prompt** and active picker; global handler only Ctrl+C/Esc
- Inline themed bands (`Bar`) using `<Text backgroundColor>`; reusable across components
- Full‑screen OSC 11 theme background with graceful degradation

#### Streaming & Concurrency
- Per‑provider streaming adapters (Anthropic `messages.stream()`, OpenAI‑compatible `stream: true`)
- `stopAtDelimiter()` leak‑proof: holds back partial multi‑char delimiter across chunks
- `streamPrinter()`: spinner clears on first token; dimmed, incremental output; `end()` resets line
- Reasoning shown live (`THINKING OUT LOUD`), JSON actions parsed silently

#### Security & Plumbing
- `.env` allowlist (`*_API_KEY`, `PROVIDER`, `MODEL`) blocks arbitrary env var poisoning
- `browser.js` file‑chooser guard: upload only when the agent’s own click is in flight
- Prompt‑injection blast radius limited by fresh, cookie‑less Playwright contexts
- VS Code style workspace: `cli/` (UI/command), `llm.js` (clients), `agent.js` (orchestration), `browser.js` (playwright)

#### Developer Experience
- `crow init` creates `.env` and explains keys with masked paste
- `crow doctor` validates Node, browser, and keys; warns on loose `.env` perms
- `crow export html|junit|json` for CI integration; HTML is self‑contained, JUnit XML for test infra
- `crow personas` lists/explains each AI user profile; `/persona-add` wizard for custom ones
- `crow config set/get` for provider, model, persona, steps, etc. (flag > env > saved > default)
- `crow resume` / TUI `/resume` picker – view + rerun past sessions
- `crow diff` — side‑by‑side diff of two runs (screenshot thumb + textual findings)
- `crow glance <url>` — quick sanity check in seconds (single AI call, no interactive confirmation)

### Development Process
All work uses a feature‑branch workflow; audit and security checks run automatically on `npm test`. The codebase has a 39‑file include list for production (everything needed to run). Node 18+ required (React 18, Ink 5); upgrades are gated behind careful testing.

### Contributing
See `README-DETAILED.md` for full docs. Custom personas can be edited in `personas.js` or added via the `/persona-add` wizard. Report issues with the fully‑formed command run via `crow doctor`.

### Known Limitations
- Synthetic users over‑agree, can’t feel genuine frustration, may misread pages
- No drag‑and‑drop upload zones (needs synthetic `DataTransfer`)
- File‑chooser interception only for agent‑triggered clicks; hidden‑input attacks still require an agent click
- SSRF / internal URLs are reachable via `--url` (fine for CLI driving trusted sites; risk rises if wrapped as a service)
- No per‑field file mapping (all upload files offered to every picker)

### License
[Apache 2.0](LICENSE) © 2026 abhyuday — open for use, modify, and commercial distribution.
