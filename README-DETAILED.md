# Scarecrow — Comprehensive Documentation

> **Synthetic user testing for your product, from the terminal.**
>
> For a quick introduction, see [README.md](./README.md).

---

## Table of Contents

- [What Is This Tool?](#what-is-this-tool)
- [Installation](#installation)
- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Commands Reference](#commands-reference)
- [All Options & Flags](#all-options--flags)
- [Interactive TUI Mode](#interactive-tui-mode)
- [Guided CLI Flow](#guided-cli-flow)
- [Confirmation Prompt](#confirmation-prompt)
- [Testing Modes](#testing-modes)
- [Personas](#personas)
- [Device Emulation](#device-emulation)
- [Video Recording](#video-recording)
- [Accessibility Auditing](#accessibility-auditing)
- [Upload Testing](#upload-testing)
- [Batch Testing](#batch-testing)
- [Session Management](#session-management)
- [Comparing Runs (Diff)](#comparing-runs-diff)
- [Export Formats](#export-formats)
- [Output Files & Artifacts](#output-files--artifacts)
- [Machine-Readable JSON Output](#machine-readable-json-output)
- [Providers & Models](#providers--models)
- [Configuration](#configuration)
- [CI/CD Integration](#cicd-integration)
- [Privacy & Security](#privacy--security)
- [Troubleshooting](#troubleshooting)
- [Glossary](#glossary)
- [Contributing](#contributing)

---

## What Is This Tool?

Scarecrow is a command-line tool that tests your website by pretending to be a real user. It opens your website in a headless browser (invisible to you), clicks around like a real person would, and then tells you what was confusing, broken, or hard to use.

**You don't need to write any code.** You just tell Scarecrow:
1. Which website to test
2. Who the "user" is (a skeptic, a beginner, a power user, etc.)
3. What they're trying to do (sign up, find pricing, etc.)

Scarecrow does the rest — clicking, scrolling, taking screenshots, and writing a report.

### What You Get Back

- A **step-by-step transcript** of what the AI "user" did and thought
- **Screenshots** at each step so you can see exactly what happened
- A **findings report** listing usability problems with severity ratings
- Optional: a **video recording** of the entire session
- Optional: an **accessibility audit** checking for WCAG compliance

---

## Installation

### What You Need

- **Node.js version 20.19 or higher (or 22.13+)** — [Download here](https://nodejs.org/)
- **A terminal** (also called "command line" or "shell")
- **An API key** from one of the supported AI providers (see [Providers](#providers--models))

### Quick Install (npm)

The fastest way — installs the `crow` command globally:

```bash
# 1. Install Scarecrow (provides the `crow` command)
npm install -g @dumbduck/scarecrow

# 2. Install the browser (~400MB on disk — only needed once)
npx playwright install chromium

# 3. Create your configuration (scaffolds a .env)
crow init

# 4. Check that everything is installed correctly
crow doctor
```

### From Source (for development)

```bash
# 1. Clone the repository (or download as a zip)
git clone https://github.com/abhyuday1602/scarecrow.git

# 2. Move into the folder
cd scarecrow

# 3. Install all dependencies
npm install

# 4. Install the browser (~400MB on disk — only needed once)
npx playwright install chromium

# 5. (Optional) Make Scarecrow available everywhere as `crow`
npm link

# 6. Create your configuration
crow init

# 7. Check that everything is installed correctly
crow doctor
```

### Setting Up Your API Key

After running `crow init`, a `.env` file is created at `~/.config/scarecrow/.env`. Open it and add your API key:

```bash
# Open the .env file in your editor
# Add ONE of these lines (remove the # and paste your key):

# For Anthropic (Claude):
# ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx

# For Gemini (Google):
# GEMINI_API_KEY=xxxxxxxxxxxx

# For Groq (open models):
# GROQ_API_KEY=gsk_xxxxxxxxxxxxxx

# Ollama runs locally and needs NO key — see the Ollama note below.
```

> Prefer not to touch `.env`? Launch `crow`, run `/provider`, pick a provider, and paste
> the key when prompted — Scarecrow writes it to `.env` for you (masked input, mode `600`).
> `/provider` only manages keys; use `/model` to pick what actually runs.

**Where do I get a key?**
- Anthropic: https://console.anthropic.com/settings/keys
- Gemini: https://aistudio.google.com/apikey
- Groq: https://console.groq.com/keys
- Ollama: no key — install from https://ollama.com/download, then `ollama serve`

---

## How It Works

Here's what happens when you run Scarecrow:

1. **You give it a URL and a persona** — e.g., "test example.com as a skeptic trying to sign up"
2. **Scarecrow opens the website** in a hidden browser window
3. **The AI "persona" looks at each screenshot** and decides what to do next
4. **It clicks, types, scrolls** — just like a real user
5. **After each step**, it takes a screenshot and records what happened
6. **When done**, it writes a report summarizing all usability problems found

The whole process takes 1-3 minutes depending on how many steps you've set.

---

## Quick Start

### Easiest Way: Interactive Mode

Just type `crow` with no arguments:

```bash
crow
```

This opens an interactive terminal where you can:
- Type `/` to see available commands
- Navigate with arrow keys
- Press Enter to select
- Fill in the URL, persona, and goal

### One-Line Command (with Confirmation)

If you know what you want to test, give all the details upfront:

```bash
crow example.com -p novice -t "sign up for a free trial"
```

You'll see a confirmation screen showing your settings before the run starts. Press Enter (or Y) to confirm, or Esc to cancel.

**To skip the confirmation** (for automation or if you're sure):

```bash
crow example.com -p novice -t "sign up for a free trial" --yes
```

### Quick First Impression (Glance Mode)

Just want a quick opinion on a page without clicking around?

```bash
crow glance example.com -p skeptic -t "is this site trustworthy"
```

This takes one screenshot and asks the AI for its honest first impression.

---

## Commands Reference

### `crow` (no arguments)

Launches the interactive terminal UI (TUI). This is the easiest way to get started.

### `crow run [url]`

Runs a full click-through test session. The persona will navigate step-by-step toward the goal.

```bash
# Basic usage
crow run example.com -p novice -t "sign up"

# With options
crow run example.com -p skeptic -t "find pricing" --steps 10 --device mobile --record

# Without the "run" word (same thing)
crow example.com -p novice -t "sign up"
```

### `crow glance [url]`

Takes a single screenshot and asks the AI for a first-impression critique. No clicking — just one look.

```bash
# Basic usage
crow glance example.com -p skeptic -t "first impression of the homepage"

# Full-page screenshot (scrolls the whole page)
crow glance example.com --full -p novice -t "what do you see on this page"
```

### `crow personas`

Lists all available personas or shows details about a specific one.

```bash
# List all personas
crow personas

# Show details for one persona
crow personas skeptic
```

### `crow doctor`

Checks that everything is installed correctly — Node.js, browser, API key, configuration.

```bash
crow doctor
```

### `crow init`

Creates your `.env` at `~/.config/scarecrow/.env` (one key, shared by every project — and
never written into a repo by accident) and an `./uploads` folder in the directory you run
it from, seeded with a README explaining how uploads work.

```bash
crow init
crow init --force   # Overwrite existing .env
```

### `crow config [action] [key] [value]`

Manage saved settings so you don't have to type them every time.

```bash
crow config                        # Show all settings
crow config get persona            # Get one setting
crow config set persona skeptic    # Save a default
crow config unset persona          # Remove a setting
crow config path                   # Show where the config file is
crow config reset                  # Reset everything to defaults
```

### `crow export <findings.json> [options]`

Convert your findings into other formats for sharing or CI integration.

```bash
# HTML report (looks great in a browser)
crow export ~/.config/scarecrow/runs/2026-01-15T10-30-00/findings.json --format html

# JUnit XML (for test runners like Jenkins, GitHub Actions)
crow export ~/.config/scarecrow/runs/2026-01-15T10-30-00/findings.json --format junit

# JSON (same as the file, but to stdout)
crow export ~/.config/scarecrow/runs/2026-01-15T10-30-00/findings.json --format json

# Specify output file
crow export ~/.config/scarecrow/runs/.../findings.json --format html -o my-report.html
```

### `crow resume [options]`

View or resume interrupted sessions.

```bash
# List all sessions (shows which can be resumed)
crow resume

# Show details about a specific session
crow resume --session ~/.config/scarecrow/runs/2026-01-15T10-30-00/

# Generate the command to re-run a session
crow resume --session ~/.config/scarecrow/runs/2026-01-15T10-30-00/ --rerun
```

### `crow diff [options]`

Compare two runs side-by-side to see if changes improved usability.

```bash
# List all runs with scores
crow diff

# Compare two specific runs
crow diff ~/.config/scarecrow/runs/2026-01-15T10-30-00/ ~/.config/scarecrow/runs/2026-01-15T11-00-00/
```

---

## All Options & Flags

These flags work with both `crow run` and `crow glance`:

### Required Flags (at least one is needed)

| Flag | Short | Description | Example |
|------|-------|-------------|---------|
| `<url>` | — | Website to test (as a positional argument) | `example.com` |
| `--persona` | `-p` | Who the test user is (see [Personas](#personas)) | `-p novice` |
| `--task` | `-t` | What the user is trying to accomplish | `-t "sign up"` |

### Optional Flags

| Flag | Short | Description | Default | Example |
|------|-------|-------------|---------|---------|
| `--steps` | `-n` | Maximum number of actions before stopping | 8 | `--steps 12` |
| `--device` | — | Viewport size: `mobile`, `tablet`, or `desktop` | desktop | `--device mobile` |
| `--headed` | — | Show the browser window (useful for watching) | true | `--headed` |
| `--no-headed` | — | Hide the browser window | — | `--no-headed` |
| `--record` | — | Save a video recording of the session | false | `--record` |
| `--a11y` | — | Run accessibility audit on each page | false | `--a11y` |
| `--upload` | — | Test file upload flows (from `./uploads/`, else the config dir) | — | `--upload` |
| `--batch` | — | Run multiple test scenarios from a JSON file | — | `--batch tests.json` |
| `--success` | — | Pass/fail check: text or URL substring to find | — | `--success "Welcome"` |
| `--ci` | — | Exit with code 1 if any high-severity findings or task failure | false | `--ci` |
| `--json` | — | Machine-readable output only (no pretty printing) | false | `--json` |
| `--quiet` | `-q` | Suppress streaming output (results only) | false | `--quiet` |
| `--yes` | `-y` | Skip confirmation prompts | false | `--yes` |
| `--out` | `-o` | Output directory for artifacts | `~/.config/scarecrow/runs/` | `--out results/` |
| `--provider` | — | AI provider: `anthropic`, `gemini`, `groq`, or `ollama` | auto | `--provider gemini` |
| `--model` | `-m` | Specific model ID (provider-dependent) | provider default | `--model gemini-2.5-flash` |
| `--help` | `-h` | Show help text | — | `--help` |
| `--version` | `-v` | Show version number | — | `--version` |

### Glance-Only Flags

| Flag | Description | Example |
|------|-------------|---------|
| `--full` | Capture and analyze the full scrollable page | `--full` |

---

## Interactive TUI Mode

When you run `crow` with no arguments, it launches the **Terminal UI (TUI)** — a rich interactive interface that guides you through setting up a test.

### How to Navigate

| Key | Action |
|-----|--------|
| **Arrow keys** ↑↓ | Move up/down in menus, or step through input history |
| **PgUp / PgDn** | Scroll back / forward through the transcript |
| **Enter** | Select the highlighted item / run |
| **Esc** | Cancel / go back / stop a run |
| **Tab** | Autocomplete the highlighted `/` command |
| **Shift+Tab** | Cycle between "walkthrough" and "glance" mode |
| **Ctrl+C** | Stop a running test, or exit (press twice) |

### Discovering Commands

In the TUI, type `/` to open the command menu. It filters as you type, scrolls to keep the
selection visible, and `Tab` autocompletes the highlighted command. The full set:

**Set up the run**
```
/url <address>        Set the target URL
/task <goal>          Set the goal (or just type it in the bar)
/persona [key]        Choose who is testing the site (no key → picker)
/provider [name]      Set or edit a provider's API key (no name → picker)
/model [id]           Pick provider + model — searchable, grouped by provider (or pass an id)
/model-rm             Remove an installed Ollama model
/steps <n>            Max actions per run
/device <preset>      Viewport: mobile | tablet | desktop
```

**Personas**
```
/personas             List all personas
/persona-add          Create a new persona (stepped wizard)
/persona-remove [key] Delete a custom persona
```

**Modes & capture**
```
/walkthrough          Step-by-step click-through mode
/glance               One-screenshot first-impression mode
/headed  /headless    Show / hide the browser window during runs
/full                 Toggle full-page glance
/success <text>       Objective success marker (walkthrough)
/upload [files]       Attach files (bare = whole uploads/ folder)
/record               Toggle video recording of the session
/a11y                 Toggle the accessibility audit (axe-core)
```

**Session & config**
```
/theme [name]         TUI color theme — opens a picker (or pass a name)
/config               Show current settings
/save                 Save current settings as defaults
/rerun                Load a past session's config to re-run
/profile [name]       Switch config profile, or list profiles
/profile-create <n>   Save current session as a new named profile
/profile-delete       Remove a saved profile
/providers            List all providers and their status
/export-format <f>    Set export format (html | junit | json)
/export [path]        Export findings in the set format
/doctor               Check setup (keys, browser, model)
/clear                Clear the screen
/help                 Show commands & keys
/quit                 Exit Scarecrow
```

**You only see these when you type `/`.** They're hidden until you ask for them, so the screen
stays clean while you're working.

### Themes

`/theme` opens a picker that **previews each theme live as you arrow through it**, so you can
see it before committing — **Enter** keeps it (and saves it to your config), **Esc** reverts to
what you had. You can also pass a name directly, e.g. `/theme tokyo`. Available themes:

`cursor` (default) · `discord` · `claude` · `tokyo` · `catppuccin` · `gruvbox` · `ocean` · `rose` · `gotham`

`cursor` is a sleek near-black editor look; `discord` and `claude` use those apps' actual
dark-mode colors; `tokyo`, `catppuccin` (Macchiato), and `gruvbox` (Material) are the classic
terminal palettes; `ocean` and `rose` are subtle teal and magenta tints; `gotham` is a
brutalist OLED-black with signal-yellow accents. Your choice persists across restarts.

Each theme also **tints the entire terminal background** to match (tokyo goes deep navy,
ocean goes deep teal, and so on), and Scarecrow restores your terminal's own background when it
exits. This uses the standard OSC 11 escape sequence, supported by every modern terminal
(kitty, alacritty, WezTerm, foot, GNOME Terminal, iTerm2, Windows Terminal); terminals that
don't support it simply ignore it, and inside tmux you may need `allow-passthrough on`.

### Creating a Persona

`/persona-add` walks you through a short wizard: **key → name → description → review**. Type to
fill each field, **Enter** (or **→**) to advance, **←** to step back and edit an earlier field
(your input is preserved). The description is multi-line (Enter inserts a newline; **→** moves
on). The final step shows the assembled **persona profile** — **Enter** saves it, **←** goes
back to edit, and **Esc** cancels the whole flow at any point. Saved personas live in your
config and are selectable with `/persona <key>`.

### TUI Flow

1. **You type a URL** in the input bar at the bottom
2. **Press Enter** to submit
3. **Answer the prompts** (persona, goal, etc.)
4. **Review the confirmation block** that appears in the transcript, then type anything — or
   just press Enter — to start the run, or press **Esc** to abort
5. **Watch the streaming output** as the test runs
6. **View findings** when the test completes

---

## Guided CLI Flow

If you provide some (but not all) required flags, Scarecrow launches a **guided step-by-step flow** to collect the missing information.

### Example

```bash
# You provide the persona, but not the URL or task
crow -p novice
```

Scarecrow will:
1. Ask you for the URL (since you didn't provide it)
2. Ask you for the goal/task (since you didn't provide it)
3. Show a **confirmation screen** with all your settings
4. Let you edit any field before starting
5. Run the test when you confirm

### When Does This Happen?

| What You Type | What Happens |
|---------------|--------------|
| `crow` (nothing) | Full interactive TUI |
| `crow -p novice` | Guided flow (missing URL + task) |
| `crow example.com` | Guided flow (missing persona + task) |
| `crow -t "sign up"` | Guided flow (missing URL + persona) |
| `crow example.com -p novice` | Guided flow (missing task) |
| `crow example.com -p novice -t "sign up"` | Confirmation prompt → run |

---

## Confirmation Prompt

When you run Scarecrow with all required information (URL, persona, and task), you'll see a **confirmation prompt** before the test starts:

```
────────────────────────────────────────────────────────────
CONFIRMATION
────────────────────────────────────────────────────────────
  url:     https://example.com
  persona: novice
  task:    sign up for a free trial
  steps:   8
  mode:    walkthrough
  browser: visible

Start the run? (Y/n)
────────────────────────────────────────────────────────────
```

**What to do:**
- Press **Enter** or **Y** to start the test
- Press **N** or **Esc** to cancel

**Why does this exist?**
It's easy to make typos. This gives you one last chance to review before spending time and API credits on a run.

### Skipping the Confirmation

Use the `--yes` (or `-y`) flag to skip the confirmation prompt:

```bash
crow example.com -p novice -t "sign up" --yes
```

This is useful for:
- Automated scripts
- CI/CD pipelines
- When you're sure you typed everything correctly

---

## Testing Modes

Scarecrow offers two main testing modes:

### 1. Session Mode (Click-Through)

**Best for:** Full user journey testing

The persona navigates your site step-by-step, clicking buttons, filling forms, scrolling, and narrating what they think at each step. After all steps are done, a "debrief" analyzes the overall experience.

```bash
# Basic session
crow example.com -p novice -t "sign up for a free trial"

# With more steps
crow example.com -p skeptic -t "find and compare pricing" --steps 12
```

**What you get:**
- Step-by-step screenshots
- Detailed transcript of thoughts and actions
- Final debrief with findings
- Optional video recording
- Optional accessibility audit

### 2. Glance Mode (First Impression)

**Best for:** Quick usability check without full navigation

Scarecrow takes one screenshot and asks the AI: "What do you think? What would confuse a real user?" No clicking, no navigation — just a single look.

```bash
# Standard viewport
crow glance example.com -p skeptic -t "is this homepage trustworthy"

# Full-page screenshot (captures everything below the fold)
crow glance example.com --full -p novice -t "what do you see on this page"
```

**What you get:**
- One screenshot
- Narrated first impression
- Structured findings
- Faster and cheaper than a full session

---

## Personas

Personas are different "user types" that Scarecrow can pretend to be. Each persona behaves differently and notices different things.

### Built-In Personas

| Persona | Who They Are | What They Notice |
|---------|--------------|------------------|
| `novice` | Margaret — cautious first-timer | Confusing jargon, buttons that don't say what they do, missing help |
| `power` | Dev — impatient power user | Slow workflows, hidden pricing and docs, cluttered UI |
| `skeptic` | Priya — privacy-conscious skeptic | Hidden fees, dark patterns, missing trust signals, pre-checked opt-ins |
| `rushed` | Marco — mobile-native, thumb-driven | Desktop-only elements, tiny tap targets, anything slow on a phone |
| `access` | Sam — low vision, scanning for barriers | Low contrast, missing labels, keyboard traps |

Run `crow personas` for this list at any time, or `crow personas <key>` for the full
description of one. Custom personas you add with `/persona-add` appear alongside these.

### How to Choose a Persona

**Not sure which to use?** Here's a simple guide:

- **Testing a public website?** → Use `skeptic` (most realistic)
- **Testing an onboarding flow?** → Use `novice`
- **Testing a productivity tool?** → Use `power`
- **Testing on a phone?** → Use `rushed` (pairs well with `--device mobile`)
- **Checking accessibility?** → Use `access` (pairs well with `--a11y`)
- **Just want a quick opinion?** → Use `skeptic` or `novice`

### Listing All Personas

```bash
crow personas
```

### Viewing a Specific Persona

```bash
crow personas skeptic
```

---

## Device Emulation

Scarecrow can test your website at different screen sizes, simulating how it looks on phones, tablets, or desktop computers.

### Available Devices

| Device | Viewport Size | User Agent |
|--------|---------------|------------|
| `mobile` | 390 x 844 | iPhone (iOS 16 Safari) |
| `tablet` | 768 x 1024 | iPad (iOS 16 Safari) |
| `desktop` (default) | 1280 x 800 | Desktop Chrome |
| `desktop-lg` | 1440 x 900 | Desktop Chrome |
| `desktop-xl` | 1920 x 1080 | Desktop Chrome |

### Usage

```bash
# Desktop (default)
crow example.com -p novice -t "sign up"

# Tablet
crow example.com -p rushed -t "sign up" --device tablet

# Mobile
crow example.com -p rushed -t "sign up" --device mobile
```

### In the TUI

Type `/device mobile` to switch to mobile mode while in the interactive terminal.

---

## Video Recording

Record the entire test session as a video file, so you can watch exactly what happened.

### Usage

```bash
crow example.com -p novice -t "sign up" --record
```

### Output

The recording is saved as `recording.webm` inside the run directory:

```
runs/
└── 2026-07-04T22-00-00-000Z/
    ├── recording.webm    ← Your video file
    ├── findings.json
    ├── report.md
    └── ...
```

### Playing the Video

Most modern video players support `.webm` files:
- **Windows:** VLC, Windows Media Player (with codec pack)
- **Mac:** VLC, QuickTime (with plugin)
- **Linux:** VLC, Totem, mpv

---

## Accessibility Auditing

Scarecrow can run an automated accessibility audit on every page it visits, checking for common WCAG (Web Content Accessibility Guidelines) violations.

### Usage

```bash
crow example.com -p access -t "check for accessibility issues" --a11y
```

### What It Checks

The audit uses [axe-core](https://github.com/dequelabs/axe-core) to detect:
- Missing alt text on images
- Low contrast text
- Missing form labels
- Keyboard navigation issues
- ARIA attribute errors
- And many more...

### Output

The audit results are included in `findings.json`:

```json
{
  "a11y": {
    "violations": [
      {
        "id": "color-contrast",
        "impact": "serious",
        "description": "Elements must have sufficient color contrast",
        "nodes": ["button.submit"],
        "helpUrl": "https://dequeuniversity.com/rules/axe/4.8/color-contrast"
      }
    ],
    "passes": 45,
    "incomplete": 3
  }
}
```

### In the TUI

Type `/a11y` to toggle the accessibility audit on/off while in the interactive terminal.

---

## Upload Testing

Test file upload flows by having the persona upload files from the `uploads/` folder.

### Where the folder lives

`--upload` looks for `./uploads` in the directory you run `crow` from, and falls back to
`~/.config/scarecrow/uploads` if there isn't one. `crow init` creates the local `./uploads`
for you, so test fixtures sit next to the site they belong to; the fallback exists so
`--upload` still works when you run `crow` from somewhere you haven't run `init`.

### Setup

```bash
# 1. Create the uploads folder (crow init does this for you)
mkdir -p uploads

# 2. Add your test files
cp test-document.pdf uploads/
cp test-image.png uploads/
```

### Usage

```bash
# Upload all files in the uploads/ folder
crow example.com -p novice -t "upload a document" --upload

# Upload specific files (by name)
crow example.com -p novice -t "upload a document" --upload test-document.pdf
```

### Security Note

For security, files must be inside the `uploads/` directory. If you try to reference a file outside this folder (e.g., `../secret.txt`), Scarecrow will reject it with a warning.

---

## Batch Testing

Run multiple test scenarios in sequence from a single JSON file.

### Creating a Batch File

Create a file called `tests.json`:

```json
[
  {
    "url": "https://example.com",
    "persona": "novice",
    "task": "sign up for a free trial",
    "steps": 6
  },
  {
    "url": "https://example.com",
    "persona": "skeptic",
    "task": "find pricing information",
    "steps": 4
  },
  {
    "url": "https://example.com",
    "persona": "power",
    "task": "export data to CSV",
    "device": "desktop",
    "steps": 10
  }
]
```

### Supported Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes* | URL to test |
| `persona` | string | yes* | Persona key (e.g., `novice`, `skeptic`) |
| `task` | string | yes* | Goal description |
| `steps` | number | no | Max actions (default: 8) |
| `device` | string | no | Viewport: `"mobile"`, `"tablet"`, or `"desktop"` |
| `headed` | boolean | no | Show browser window |
| `record` | boolean | no | Save video recording |

\* Each run must specify at least `url` or `task`. A missing `persona` will use a random one.

### Running a Batch

```bash
# Basic batch run
crow run --batch tests.json

# With CI exit code (non-zero if any test fails)
crow run --batch tests.json --ci
```

### Batch Validation

Before running, Scarecrow validates each entry in the batch file:

- **Unknown fields** produce warnings with suggestions (e.g., "did you mean 'persona' instead of 'personaKey'?")
- **Missing required fields** (both `url` and `task` are missing) produce errors
- **Missing persona** produces a warning

Example error output:

```
BATCH VALIDATION ERRORS

  ✗ run #2: no "persona" set — a random one will be used
  ✗ run #3: needs at least "url" or "task"
  ✗ run #4: unknown field "a11yEnabled" — did you mean "a11y"? (ignored)
```

---

## Session Management

Scarecrow saves information about each run, so you can resume interrupted sessions or compare results.

### Viewing Sessions

```bash
# List all sessions
crow resume
```

This shows something like:

```
Resumable sessions:
  runs/2026-07-04T22-00-00/  interrupted (step 4/8) — example.com — "sign up"
  runs/2026-07-04T23-15-00/  completed — example.com — "find pricing"

All sessions:
  ✓ runs/2026-07-04T22-00-00/  interrupted  (step 4/8)
  ✓ runs/2026-07-04T23-15-00/  completed
  ✓ runs/2026-07-04T23-30-00/  completed
```

### Session Details

```bash
crow resume --session ~/.config/scarecrow/runs/2026-07-04T22-00-00/
```

This shows:
- Session metadata (URL, persona, task, step count)
- The re-run command to continue

### Re-Running a Session

```bash
# Generate the command to re-run
crow resume --session ~/.config/scarecrow/runs/2026-07-04T22-00-00/ --rerun

# It will output something like:
# crow run example.com -p novice -t "sign up" --steps 8
```

---

## Comparing Runs (Diff)

Compare two test runs to see if changes improved usability.

### Listing All Runs

```bash
crow diff
```

Shows a list of all runs with scores:

```
Available runs (most recent first):
  1. runs/2026-07-04T23-30-00/ — score: 5 — example.com — "find pricing"
  2. runs/2026-07-04T23-15-00/ — score: 12 — example.com — "sign up"
  3. runs/2026-07-04T22-00-00/ — score: 8 — example.com — "sign up"
```

### Comparing Two Runs

```bash
crow diff ~/.config/scarecrow/runs/2026-07-04T22-00-00/ ~/.config/scarecrow/runs/2026-07-04T23-30-00/
```

Example output:

```
═══════════════════════════════════════════════════════════
                   RUN COMPARISON REPORT
═══════════════════════════════════════════════════════════

URLs:
  Run 1: https://example.com
  Run 2: https://example.com
  ✓ Same URL

OUTCOMES
  Run 1: reached the goal
  Run 2: reached the goal
  ✓ Same outcome

FINDINGS COUNT
  Run 1: 3 findings
  Run 2: 1 finding
  Change: -2

IMPROVEMENT ANALYSIS
  Score 1: 15 (lower is better)
  Score 2: 5 (lower is better)
  Change: -10
  Status: ✓ IMPROVED
═══════════════════════════════════════════════════════════
```

---

## Export Formats

Convert your findings into different formats for sharing or CI integration.

### HTML Report

A self-contained HTML file with styling — looks great in any browser.

```bash
crow export ~/.config/scarecrow/runs/2026-07-04T23-30-00/findings.json --format html
# Creates: export.html
```

### JUnit XML

For CI pipelines (Jenkins, GitHub Actions, GitLab CI, etc.).

```bash
crow export ~/.config/scarecrow/runs/2026-07-04T23-30-00/findings.json --format junit
# Creates: export.xml
```

### JSON

Raw JSON output (same as the file contents).

```bash
crow export ~/.config/scarecrow/runs/2026-07-04T23-30-00/findings.json --format json
```

### Specifying Output File

```bash
crow export ~/.config/scarecrow/runs/.../findings.json --format html -o my-report.html
```

---

## Output Files & Artifacts

Each test run creates a folder in `~/.config/scarecrow/runs/` (override with `-o/--out`)
with the following files:

```
~/.config/scarecrow/runs/
└── 2026-07-04T23-30-00-000Z/
    ├── step-01.png          ← Screenshot at step 1
    ├── step-02.png          ← Screenshot at step 2
    ├── ...
    ├── step-08.png          ← Screenshot at final step
    ├── findings.json        ← Machine-readable findings
    ├── report.md            ← Human-readable markdown report
    ├── session-state.json   ← Session state (for resume)
    └── recording.webm       ← Video recording (if --record)
```

### findings.json

Contains all test results in JSON format (see [Machine-Readable JSON Output](#machine-readable-json-output) for details).

### report.md

A markdown file with:
- Full transcript of the session
- Step-by-step screenshots
- Final debrief reflection
- Structured findings

---

## Machine-Readable JSON Output

When you use `--json`, Scarecrow outputs a single JSON object to stdout. This is useful for scripts, CI pipelines, or programmatic access.

### JSON Shape (Both Modes)

Both `run` and `glance` modes now share a consistent metadata envelope:

```json
{
  "url": "https://example.com",
  "provider": "gemini",
  "model": "gemini-2.5-flash",
  "persona": "skeptic",
  "goal": "sign up for a free trial",
  "mode": "session",
  "timestamp": "2026-07-04T23:30:00.000Z"
}
```

**Key fields:**

| Field | Description |
|-------|-------------|
| `url` | The URL that was tested |
| `provider` | Which AI provider was used |
| `model` | Which model was used |
| `persona` | The persona key |
| `goal` | The task description |
| `mode` | Either `"session"` or `"glance"` |
| `timestamp` | When the run started (ISO 8601) |

### Session Mode Additional Fields

```json
{
  "outcome": "reached the goal",
  "finalUrl": "https://example.com/signup/success",
  "assertion": {
    "marker": "Welcome",
    "passed": true
  },
  "a11y": {
    "violations": [...],
    "passes": 45,
    "incomplete": 3
  },
  "routeHistory": [
    { "url": "https://example.com", "type": "navigate", "timestamp": 1234567890 },
    { "url": "https://example.com/pricing", "type": "click", "timestamp": 1234567891 }
  ]
}
```

### Glance Mode Additional Fields

```json
{
  "narration": "The homepage has a clear call-to-action, but the pricing link is hidden...",
  "severity": "medium",
  "findings": [
    {
      "issue": "Pricing information is not immediately visible",
      "severity": "medium",
      "heuristic": "Visibility of system status",
      "fix": "Add a 'Pricing' link to the main navigation"
    }
  ],
  "wouldCompleteTask": "yes"
}
```

### Both Modes Include Findings

Both modes spread the findings object at the top level:

```json
{
  "...metadata fields...",
  "severity": "medium",
  "wouldCompleteTask": "yes",
  "findings": [
    {
      "issue": "Unclear pricing information",
      "severity": "medium",
      "heuristic": "Match between system and real world",
      "fix": "Add clear pricing table on homepage"
    }
  ]
}
```

### Using JSON in Scripts

```bash
# Capture JSON output
OUTPUT=$(crow example.com -p novice -t "sign up" --json --quiet)

# Extract severity
echo "$OUTPUT" | jq '.severity'

# Check if task would be completed
echo "$OUTPUT" | jq '.wouldCompleteTask'

# Count findings
echo "$OUTPUT" | jq '.findings | length'
```

---

## Providers & Models

Scarecrow supports four AI providers. Each has different pricing, speed, and model options.

### Supported Providers

| Provider | API Key Env Var | Default Model | Get a Key |
|----------|-----------------|---------------|-----------|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` | [aistudio.google.com](https://aistudio.google.com/apikey) |
| Groq | `GROQ_API_KEY` | `meta-llama/llama-4-scout-17b-16e-instruct` | [console.groq.com](https://console.groq.com/keys) |
| Ollama | _(local — no key)_ | `qwen3-vl` | [ollama.com/download](https://ollama.com/download) |

### Adding a Key Without Editing `.env`

In interactive mode, run `/provider` (no argument) to open the key manager. It lists the
key-based providers (Ollama isn't shown — it's local and keyless) with their status
(`key set · edit` / `not set · add`). Pick one and paste the key — the input is masked,
saved to `.env` (mode `600`), and applied immediately, so the next run uses it with no
restart. `/provider` only ever manages keys; it never switches what's running — that's
`/model`'s job (below).

### How Provider Selection Works

1. If you set `--provider`, that's used
2. Otherwise, if you have a `PROVIDER` environment variable, that's used
3. Otherwise, Scarecrow looks for which API key you have set and uses that provider
4. If multiple keys are set, it defaults to `anthropic`

Auto-detection only considers the key-based providers — Ollama has no key, so select it
explicitly: `--provider ollama`, `PROVIDER=ollama`, `crow config set provider ollama`, or
pick it from `/model` in interactive mode.

### Changing Provider

```bash
# Via flag
crow example.com -p novice -t "sign up" --provider gemini

# Via environment variable
export PROVIDER=gemini
crow example.com -p novice -t "sign up"

# Via saved config (persists across runs)
crow config set provider gemini
```

### Changing Models

```bash
# Use a specific model
crow example.com -p novice -t "sign up" --provider gemini --model gemini-2.5-flash

# Use a Groq model (must be vision-capable — text-only models can't see screenshots)
crow example.com -p novice -t "sign up" --provider groq --model meta-llama/llama-4-scout-17b-16e-instruct
```

In interactive mode, `/model` opens a unified, searchable picker: every provider you've
configured (a key set, plus Ollama, which is always available) is shown as a group with its
curated models underneath (Ollama models show install status and size). Picking a model sets
the provider and model together — there's no separate provider-switch step. Type to filter by model id or provider
name; `/model <id>` still sets any id directly under whatever provider is currently active.

### Groq Note

Groq hosts open-source models and rotates them frequently. The model **must support vision** (text-only models can't see screenshots). The suggested picks are `meta-llama/llama-4-scout-17b-16e-instruct` (default) and `qwen/qwen3.6-27b`; check the current lineup at [groq.com/docs/vision](https://console.groq.com/docs/vision).

### Ollama Note (local, keyless)

Ollama runs models on your own machine — no API key, no per-token cost. In the TUI:

- `/model` shows it alongside other providers; picking an uninstalled model
  **auto-installs Ollama, starts the daemon, and pulls the model** — no manual steps.
- `/model-rm` removes an installed Ollama model.

From the CLI, set it up once:

```bash
# 1. Install from https://ollama.com/download, then start the daemon
ollama serve

# 2. Pull a vision model (must support images)
ollama pull qwen3-vl

# 3. Point Scarecrow at it
crow example.com -p novice -t "sign up" --provider ollama --model qwen3-vl
```

The suggested models are `qwen3-vl` (default), `qwen3`, `llama3.2-vision`,
`llama3.2`, `llava`, `moondream`, `gemma3`, and `gemma2` — each showing its
approximate size and install status in `/model`. Pulled something else?
`/model <id>` sets any id directly.

---

## Configuration

Scarecrow can save your preferences so you don't have to type them every time.

### Config Precedence

Settings are resolved in this order (highest to lowest):

1. **Command-line flags** — `--persona skeptic`
2. **Environment variables** — `PROVIDER=gemini`
3. **Saved config** — `crow config set persona skeptic`
4. **Built-in defaults** — persona: `novice`, steps: `8`, etc.

### Available Settings

| Setting | Description | Example |
|---------|-------------|---------|
| `provider` | Default AI provider | `crow config set provider gemini` |
| `model` | Default model | `crow config set model gemini-2.5-flash` |
| `persona` | Default persona | `crow config set persona skeptic` |
| `steps` | Default step count | `crow config set steps 6` |
| `device` | Default viewport | `crow config set device mobile` |
| `headed` | Show browser by default | `crow config set headed false` |
| `full` | Full-page glance by default | `crow config set full true` |
| `color` | Enable/disable colors | `crow config set color false` |
| `theme` | Default TUI color theme | `crow config set theme tokyo` |

### Config File Location

```bash
crow config path
# Shows: /home/user/.config/scarecrow/config.json (Linux)
# or similar on Mac/Windows
```

### Resetting Configuration

```bash
crow config reset
```

---

## CI/CD Integration

Scarecrow works great in continuous integration pipelines.

### Basic CI Usage

```bash
# Run a single test
crow run example.com -p skeptic -t "sign up" --ci --no-headed --json

# Run a batch of tests
crow run --batch tests.json --ci

# Exit code: 0 = pass, 1 = fail (high-severity findings or task failure)
```

### CI Flags

| Flag | Purpose |
|------|---------|
| `--ci` | Exit with code 1 on failure |
| `--no-headed` | Run headless (no browser window) |
| `--json` | Machine-readable output |
| `--quiet` | Suppress streaming output |

### GitHub Actions Example

```yaml
name: Usability Test
on: [push]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      - run: npx playwright install chromium
      - run: crow run example.com -p skeptic -t "sign up" --ci --no-headed --json
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### JUnit for Test Runners

```bash
# Run tests
crow run --batch tests.json --ci

# Export to JUnit XML
for dir in runs/*/; do
  crow export "$dir/findings.json" --format junit -o "junit/$(basename $dir).xml"
done
```

---

## Privacy & Security

Scarecrow's whole job is to show a page to an LLM and let it act — so it's worth being
explicit about where data flows.

### What leaves your machine

On every step, the provider you configured (Anthropic, Gemini, Groq, or a local Ollama daemon) receives:

- a **screenshot** of the page (which may show usernames, order data, anything visible),
- the page's **visible text and interactive elements**,
- the **full URL**, including query strings (which sometimes carry tokens),
- your **task text and persona** — including anything sensitive you typed into them.

The same data is written in plaintext to `runs/<timestamp>/` (screenshots, transcript,
findings). That directory is gitignored, but treat it as sensitive and purge it
periodically — especially before sharing a machine or a backup.

### Credentials policy

**Never give Scarecrow real, personal, or production logins.** Anything typed during a
run is part of the prompt (sent to the provider), lands in the transcript on disk, and
the username usually appears in screenshots. If a flow needs a login, use a **disposable
test account on a staging site**. Real logins also tend to trip bot detection and MFA,
so they usually fail anyway.

### The agent acts on what pages tell it

Page content drives the agent's decisions, which means an adversarial page can try to
steer it (prompt injection). Mitigations built in:

- Each run uses a **fresh, cookie-less browser context** — the agent is never
  authenticated anywhere unless you typed credentials in (see above).
- `--upload` files attach **only to file dialogs opened by the agent's own click**; a
  hidden file input a page springs on its own is cancelled and logged.
- The model picks elements by number; its output is validated before it touches the page.

Still: **only point Scarecrow at sites you own or trust.** Note that internal URLs
(`localhost`, private ranges) are reachable by design — fine for a CLI you drive
yourself; don't wrap Scarecrow as a service that accepts URLs from strangers without
adding URL validation.

### Key handling

- Keys are read from your shell env or a `.env` in the tool's folder; `crow init`
  writes it with **mode 600** and masks the key as you paste it.
- Only `*_API_KEY`, `PROVIDER`, and `MODEL` are ever loaded from a `.env` — other
  variables (proxies, `NODE_OPTIONS`, …) are ignored, so a planted `.env` in some
  directory can't redirect your traffic.
- `crow doctor` reports which keys are present but never prints their values, and
  warns if your `.env` is readable by other users.

---

## Troubleshooting

### "Browser not found" or "Executable doesn't exist"

The Playwright browser isn't installed. Run:

```bash
npx playwright install chromium
# or
crow doctor
```

### "API key not found"

Your API key isn't set. Check:

1. Is the `.env` file in the project root?
2. Is the key correct (no extra spaces or quotes)?
3. Run `crow doctor` to verify

```bash
# Manual check
cat .env

# Or set directly (for this session only)
export ANTHROPIC_API_KEY=your_key_here
```

### "Node.js version too old"

Scarecrow needs Node.js 20.19 or higher (or 22.13+). Upgrade at [nodejs.org](https://nodejs.org/).

```bash
node --version  # Should show v20.19.x or higher (or v22.13.x+)
```

### "Model doesn't support vision"

For Groq, the model must support vision (seeing images). Use a vision-capable model:

```bash
crow example.com -p novice -t "sign up" --provider groq --model meta-llama/llama-4-scout-17b-16e-instruct
```

### "Upload file must be inside uploads/ directory"

Files for upload testing must be in the uploads folder, referenced by bare filename —
absolute paths and anything outside the folder are rejected. Move them there first:

```bash
cp my-file.pdf uploads/
crow example.com -p novice -t "upload" --upload
```

If you get "no such file or directory", you don't have an `./uploads` here yet — run
`crow init`, or check `crow doctor`, which prints the folder it's actually using.

### Slow Performance

- Use `--steps` to limit session length
- Use `glance` for quick checks instead of full sessions
- Use `--no-headed` to skip rendering the browser window
- Use a cheaper/faster model (e.g., Gemini Flash)

### Watch the Browser in Action

Use `--headed` to see the browser window while the test runs:

```bash
crow run example.com -p novice -t "sign up" --headed
```

---

## Glossary

| Term | Definition |
|------|------------|
| **Persona** | A fake "user type" that Scarecrow pretends to be (e.g., skeptic, novice) |
| **Session** | A full click-through test where the persona navigates step-by-step |
| **Glance** | A quick first-impression test (one screenshot, no clicking) |
| **Findings** | The usability problems discovered during a test |
| **Severity** | How bad the problem is: `low`, `medium`, `high`, `critical` |
| **Heuristic** | A usability principle (e.g., "visibility of system status") |
| **TUI** | Terminal User Interface — the interactive mode you see when you type `crow` |
| **Headless** | Running the browser invisibly (no window shown) |
| **CI** | Continuous Integration — automated testing in pipelines like GitHub Actions |
| **Batch** | Running multiple test scenarios in sequence from a JSON file |
| **Route history** | The list of pages the persona visited during a session |

---

## Contributing

### Development Setup

```bash
git clone <repository-url>
cd scarecrow
npm install
npm test       # Run test suite
npm run lint   # Check code style
```

### Running Tests

```bash
npm test                    # Run all tests
npm test -- --watch         # Watch mode (re-runs on changes)
npm test -- --coverage      # Coverage report
```

### Code Style

```bash
npm run lint               # Check for issues
npm run lint -- --fix      # Auto-fix
```

---

## License

Apache 2.0

---

## Support

- **Issues**: [GitHub Issues](https://github.com/abhyuday1602/scarecrow/issues)
- **Documentation**: [README.md](./README.md) for quick start
