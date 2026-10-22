# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately
through GitHub's [private vulnerability reporting](https://github.com/abhyuday1602/scarecrow/security/advisories/new)
for this repository. Include the version (`crow --version`), your OS and Node version,
and the smallest steps that reproduce the problem.

You should get an acknowledgement within a week. Fixes for confirmed issues ship in
the next release, and the CHANGELOG credits the reporter unless you'd rather not be named.

## Supported versions

Only the latest release gets security fixes.

## What Scarecrow handles, and the threat model

Scarecrow drives a real browser against pages you point it at and sends what it sees
to an LLM provider. The things worth protecting, and the boundaries we rely on:

- **API keys.** Stored in `~/.config/scarecrow/.env` (mode 600) or your shell
  environment. Only `*_API_KEY`, `PROVIDER` and `MODEL` are read from a `.env`, so a
  project-local `.env` can't inject `NODE_OPTIONS`, proxies, or other process settings.
  A key ending up in logs, reports, screenshots or anywhere outside that file is a bug.
- **Hostile pages.** Any page can try to steer the persona through its content (prompt
  injection) or abuse the browser. Runs use a fresh, cookie-less browser context, and
  targets are limited to `http://` and `https://`. Link-local addresses, including the
  `169.254.169.254` cloud metadata endpoint, are refused. `localhost` and private
  networks are allowed on purpose, because testing your own dev server is the main use.
- **Your files.** Files from `uploads/` are only attached to a file picker that the
  agent's own click opened. A page that opens a hidden file input by itself gets nothing.
  `--upload` only accepts files inside the uploads folder, including after symlinks
  are resolved.
- **Run artifacts.** Screenshots, page text, URLs and anything typed during a run are
  written in plain text under `~/.config/scarecrow/runs/` and sent to your provider.
  Never use real credentials in a task.

Reports about anything that breaks one of these boundaries are especially welcome:
key leakage, upload exfiltration, reaching link-local or `file://` targets, or a page
that can make Scarecrow act outside the run it was started for.
