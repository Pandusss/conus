# Contributing to Conus

Thanks for helping. Issues, ideas and pull requests are welcome, in English or Russian.

## The layout

| Package | What it is |
|---|---|
| `packages/core` | The domain: tasks, sessions, the janitor, the Stop-hook check, the judge. Postgres. |
| `packages/server` | HTTP API (Hono): the hooks API, the web app API, the MCP endpoint `/mcp`. |
| `packages/cli` | `conus-cli` on npm: `conus setup`, agent hooks, the outbox, the `conus mcp` bridge. |
| `packages/protocol` | Everything agents read: the protocol, MCP instructions, tool descriptions, the skill. |
| `packages/ui` | The web app (React, Vite, TanStack Query). |
| `packages/evals` | Scenario runs with real agents (Claude Code, Codex) against a real server. |
| `integrations/claude-code` | The Claude Code plugin; `.claude-plugin/marketplace.json` makes the repo its marketplace. |
| `deploy` | The Docker image, `compose.yml`, `install.sh`. |

## Getting started

You need Node.js 22 or newer and Docker.

```bash
npm ci
npm run dev
```

`npm run dev` starts Postgres in Docker, the server from source on http://localhost:8080 (it restarts on changes)
and the web app on http://localhost:5173. On the first visit enter the setup code `DEVS-ETUP` and choose a password.
To point an agent at it: `conus setup http://localhost:8080 <token>` with a token from Agents → Connect agent
(`npm run cli:install` installs your local `conus`).

## Checks

```bash
npm run typecheck
npm test            # Postgres via testcontainers, or set TEST_DATABASE_URL (the dev database works)
npm run test:ui
```

CI runs the same, plus `npm run gen` and `npm run gen:icon` and fails if they change anything: run them after
editing `packages/protocol` (the plugin's skill), the MCP bridge (`packages/cli/src/mcp-*.ts`) or the icon.

## Conventions

- Commits follow Conventional Commits: `feat(cli): …`, `fix(core): …`, `docs: …`. The subject says what changes
  for a user; the body says why.
- A behaviour change comes with a test. Bugs get a test that fails before the fix.
- Text agents read is English and lives in `packages/protocol` (or the server's tool results). Text people read
  is in English and Russian: the web app's dictionaries in `packages/ui/src/i18n`, `t(en, ru)` in the CLI
  (`packages/cli/src/i18n.ts`) and on the server (`packages/core/src/lang.ts`, chosen by `CONUS_LANG`).
- Privacy is a feature: the client never sends file contents or diffs. Anything new that leaves the machine is
  listed in the README's privacy section in the same pull request.
- Hooks never break the agent: a hook exits 0 and stays silent on any error (it logs to `~/.conus/logs`).

## Releasing (maintainers)

Bump `version` in `packages/cli/package.json` (the CLI reads it from there), add a `CHANGELOG.md` entry, merge,
then tag: `git tag v0.2.0 && git push origin v0.2.0`. The release workflow publishes the server image to
`ghcr.io/pandusss/conus` and `conus-cli` to npm.

## License

By contributing you agree that your contribution is licensed under the MIT License of this repository.
