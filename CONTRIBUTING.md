# Contributing to Scarecrow

Thanks for wanting to help. Bug reports, persona ideas, fixes and docs are all welcome.
This guide covers how to get set up and what a pull request needs to get merged.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and asking for features

Open an issue with the [bug report](https://github.com/abhyuday1602/scarecrow/issues/new?template=bug_report.yml)
or [feature request](https://github.com/abhyuday1602/scarecrow/issues/new?template=feature_request.yml)
template. For bugs, `crow doctor` output and the smallest command that reproduces the
problem save a lot of back and forth. Redact API keys and anything private from logs
and screenshots.

**Security problems never go in a public issue.** See [SECURITY.md](SECURITY.md).

## Development setup

You need **Node.js 20.19+ (or 22.13+, or 24+)**.

```bash
git clone https://github.com/abhyuday1602/scarecrow
cd scarecrow
npm install
npm link                          # puts your working copy on your PATH as `crow`
npx playwright install chromium   # the browser the engine and browser tests use
crow doctor                       # check Node, browser and keys
```

To try a change without an API key, use a local [Ollama](https://ollama.com) model
(`crow --provider ollama …`).

## Where things live

| Path | What it does |
| --- | --- |
| `index.js` | Entry point: argument parsing, routing, error-to-exit-code handling |
| `agent.js` | The run loop: observe the page, ask the model, act, debrief |
| `browser.js` | Playwright: element numbering, actions, screenshots, request guards |
| `llm.js` | Provider clients, structured replies, the retry layer, the test cassette |
| `personas.js` | Built-in personas (a persona's description *is* its prompt) |
| `cli/` | Commands, reports and exports, config, onboarding |
| `cli/tui/` | The interactive Ink interface |
| `__tests__/` | Vitest tests, with fixture pages in `__tests__/fixtures/` |

The [How it works](README.md#how-it-works) and [Engineering notes](README.md#engineering-notes)
sections of the README walk through the design in more depth.

## Tests and lint

```bash
npm run lint      # eslint
npm test          # vitest, once
npm run test:watch
```

The tests need no API key and make no network calls. Browser tests run a real Chromium
against the small pages in `__tests__/fixtures/`, and run-loop tests replay the model's
replies from a cassette: set `SCARECROW_LLM_CASSETTE=<file.json>` with
`SCARECROW_LLM_MODE=record` to record one from a real run, and `replay` (the default)
to play it back. Browser tests are skipped, with a warning, if Chromium isn't installed.

CI runs lint and tests on Node 20, 22 and 24 for every pull request.

## Pull requests

1. Branch from `main`, and keep each PR to one change.
2. Add a test for new behaviour or a fixed bug, ideally one that fails without the fix.
   If something can't be tested, say why in the PR.
3. Add a line to `CHANGELOG.md` under **Unreleased** for anything a user would notice,
   and update the README if flags, commands or output change.
4. Run `npm run lint && npm test` before pushing.
5. Fill in the PR template: what changed, why, and how you tested it.

If an AI assistant helped write a change, that's fine: keep its `Co-Authored-By:`
trailer in the commit, and review the code as carefully as you would your own.

## Proposing a persona

Personas are the heart of Scarecrow, so new ones are welcome. Try yours first with
`/persona-add` in the interactive mode, then open a
[persona proposal](https://github.com/abhyuday1602/scarecrow/issues/new?template=persona.yml).
The best proposals describe *behaviour*, such as how the persona reads a page, what it
clicks and when it gives up, rather than demographics, and say what it catches that the
existing personas miss.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same as the project.
