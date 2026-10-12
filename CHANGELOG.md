# Changelog

## 0.1.0 — 2026-10-12

The first public release.

- A task manager that Claude Code, Codex and other agents keep themselves: they create main tasks, take them,
  block, complete with a result and drop them, over MCP, and the server reconciles with hooks and git facts.
- `conus-cli` (npm, or `conus-cli.tgz` in each release): `conus setup` connects every agent on a machine in one
  command; `conus mcp` lets agents reach the server without environment variables; `conus doctor` checks the chain.
- The server as one Docker image with `deploy/install.sh`: local, behind your proxy or with built-in HTTPS; the
  owner password is set in the browser on the first visit.
- The web app: board with drag and drop, task drawer, proposals inbox, sessions, agents; English and Russian.
