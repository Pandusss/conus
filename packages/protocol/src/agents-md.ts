export const AGENTS_MD_START = '<!-- conus:start -->';
export const AGENTS_MD_END = '<!-- conus:end -->';
export const AGENTS_MD_BLOCK = `${AGENTS_MD_START}
## Task manager (Conus)

This repository is connected to the user's task manager (Conus). Keep MAIN tasks in sync on your own — follow the \`task-protocol\` skill or the Conus MCP server instructions: start or create a task before implementing a main piece of work, complete it with a result when done, block or drop when needed, propose significant ideas. Small edits and plan steps are not tasks. Never ask the user about task bookkeeping. When Conus calls changed something, end the reply with one line "Tasks: …" (the word "Tasks" in the conversation language).
${AGENTS_MD_END}
`;

/** The same rule for an agent's global instruction file (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md). */
export const GLOBAL_RULES_BLOCK = `${AGENTS_MD_START}
## Task manager (Conus)

The user tracks their work in their own task manager (Conus). In every session where the Conus MCP tools are available, keep the MAIN tasks of the current repository in sync on your own — follow the \`task-protocol\` skill or the Conus MCP server instructions: check the open tasks first (the <task-manager> context block or \`tasks_context\`), start or create a task before implementing a main piece of work, complete it with a result when done, block or drop it when needed, propose significant ideas instead of turning them into tasks. Small edits and plan steps are not tasks. Never ask the user about task bookkeeping. When Conus calls changed something, end the reply with one line "Tasks: …" (the word "Tasks" in the conversation language). If the Conus tools are not available, ignore this section.
${AGENTS_MD_END}
`;
