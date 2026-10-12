# conus-cli

The agent side of [Conus](https://github.com/Pandusss/conus), a task manager your AI agents keep themselves.
It connects Claude Code, Codex and Gemini CLI on this machine to your Conus server.

```bash
npm install -g conus-cli
conus setup https://conus.example.com conus_xxxxxxxx
```

The token comes from the Conus web app: **Agents → Connect agent**. `conus setup` logs in, installs the Conus plugin
in Claude Code, the MCP server and hooks in Codex, the MCP server in Gemini CLI, and checks the whole chain.

| Command | What it does |
|---|---|
| `conus setup [<url> <token>]` | Log in and connect every agent found on this machine |
| `conus doctor` | Check the configuration, the server, the token, PATH and each agent |
| `conus install claude\|codex\|gemini\|rules` | Connect one agent, or add the Conus rule to every agent's global instructions |
| `conus disable` / `conus enable` | Stop or resume tracking in the current git repository |
| `conus mcp` | The stdio MCP server agents start; it relays to your Conus server |
| `conus hook <event> --agent <claude\|codex>` | Called by agent hooks |

Requires Node.js 22 or newer. Messages are in English, or in Russian when your locale is Russian.
See the [main README](https://github.com/Pandusss/conus#readme) for what is sent to the server and how to turn it off.

MIT License.
