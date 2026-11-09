# Changelog

## Unreleased

- **The manager**: with `ANTHROPIC_API_KEY` set, Conus reviews all open tasks every morning (priorities — never ones
  you set — today's focus, likely duplicates, stale and vague tasks, deadlines at risk) and turns correspondence you
  paste under Proposals or forward to the bot into proposals in the right projects, with a priority, a date and the
  quote. The overview shows the latest review; agents see the focus for their project at session start. Claude Opus
  5.5 by default (`CONUS_MANAGER_MODEL`).
- **Telegram**: set `CONUS_TELEGRAM_BOT_TOKEN` and link your chat in the new Settings page: a morning digest, notices
  when a task waits for your check (accept or return it with a button) or an agent is blocked, quiet hours, `/digest`
  and `/review`. Long polling: no public webhook.
- **Reminders**: between digests the bot reminds you every few hours (3 by default; 1–12 or off in Settings) for as
  long as something waits for you: checks, blockers, deadlines, proposals, the unfinished focus. Nothing waits, no
  message. Quiet hours hold, a reminder right before the digest or right after a fresh notice is skipped, and one
  button silences them until the next digest. `/now` shows the list on demand.
- The bot's messages are easier to read: a headline, sections with counts, each task a link to it in the web app, the
  reason for a block or a priority change on its own line, long parts folded into a quote. A long review comes as
  several messages instead of being cut.
- Tasks can be moved to another project (the drawer's menu, or the bot's 📁 button).
- The web app opens on an **Overview**: every project on one screen — what is in progress and which agent is on it,
  what is blocked and why, what waits for your check, what is next, and a «Waiting for you» list across projects
  (checks, blockers, deadlines, proposals). Quiet projects fold away. The board moved to `/board`.
- Tasks have a **priority** (urgent / high / normal / low) and a **due date**. Set them in the task or from a card's
  menu; the board puts the most urgent work on top of each open column, and agents see their project's open tasks in
  that order at session start, with the priority and date spelled out. A priority you set is pinned.
- `install.sh` works without a terminal (CI, `ssh` without a tty): it used to stop at the domain question.
- A workflow runs the newcomer's path on a clean machine after every release and weekly: the installer, the
  first-run setup, `conus-cli` from npm, `conus setup` and the MCP bridge.

## 0.2.2 — 2026-10-13

- `conus-cli` is on the npm registry: `npm install -g conus-cli` in the web app, the READMEs and the installer.
  Releases publish it from GitHub Actions (trusted publishing); the package is still attached to every release.

## 0.2.1 — 2026-10-13

- English is the default everywhere; Russian only by choice. The web app no longer follows the browser's
  language (the EN/RU switch remembers a choice), the CLI no longer follows the system locale
  (`conus config set lang ru` or `CONUS_LANG=ru`), and `install.sh` sets `CONUS_LANG=en` unless told otherwise.

## 0.2.0 — 2026-10-13

- The logo assembles itself: dust flies along arcs into the Rule 30 cone and the word conus — on the web app's
  sign-in and setup screens (once; still with reduced motion), in `conus logo` and before `conus setup` (terminals
  only), and at the top of the README. One model for all three: `packages/brand`.

## 0.1.1 — 2026-10-12

- Agents get the CLI from the latest GitHub release: the web app, the READMEs and the installer show
  `npm install -g --allow-remote=all https://github.com/Pandusss/conus/releases/latest/download/conus-cli.tgz`
  (`--allow-remote=all` is what npm 12 needs to install from a URL).
- Release: the CLI package is attached to every GitHub release.

## 0.1.0 — 2026-10-12

The first public release.

- A task manager that Claude Code, Codex and other agents keep themselves: they create main tasks, take them,
  block, complete with a result and drop them, over MCP, and the server reconciles with hooks and git facts.
- `conus-cli` (npm, or `conus-cli.tgz` in each release): `conus setup` connects every agent on a machine in one
  command; `conus mcp` lets agents reach the server without environment variables; `conus doctor` checks the chain.
- The server as one Docker image with `deploy/install.sh`: local, behind your proxy or with built-in HTTPS; the
  owner password is set in the browser on the first visit.
- The web app: board with drag and drop, task drawer, proposals inbox, sessions, agents; English and Russian.
