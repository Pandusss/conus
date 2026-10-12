# Security

Conus holds agent tokens, an owner password and what agents report about your work, so security reports matter.

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on
[github.com/Pandusss/conus](https://github.com/Pandusss/conus/security/advisories/new). Please do not open a public
issue. You will get an answer within a few days; once a fix is released, the advisory is published with credit,
unless you prefer otherwise.

## What is in scope

- the server: authentication of agents (tokens) and of the owner (password, sessions, CSRF), the first-run setup,
  access control between agents, input validation, the MCP endpoint;
- `conus-cli`: what it sends to the server, the files it writes (`~/.conus`, agent configs), the hooks;
- the Docker image and `deploy/install.sh`.

## How Conus treats secrets

- Agent tokens are stored on the server only as SHA-256 hashes and can be revoked in the web app.
- The owner password is hashed with argon2id; changing it ends every owner session.
- On an agent's machine the token lives in `~/.conus/config.json`, readable by its owner only.
- File contents and diffs never leave the machine; see the README for the full list of what is sent.
