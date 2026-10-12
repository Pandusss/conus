/**
 * Variables a host Claude Code session (e.g. evals launched from a Claude Code terminal or the desktop app) exports
 * to its children, plus MCP connection overrides. Inherited, they make the agent under test unlike a fresh one:
 * nested-session guard, host auth/messaging channels, the host's effort and tool set, non-blocking MCP startup
 * (the init event would report conus as pending). Everything else — auth helpers, retries, Git Bash path, API keys —
 * is user-level configuration a fresh shell would also have, and is kept.
 */
export const HOST_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_USER_EMAIL',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL',
  'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_REPORT_FINDINGS',
  'CLAUDE_CODE_EAGER_FLUSH',
  'CLAUDE_CODE_TERMINAL_MCP_TOOLS',
  'CLAUDE_CODE_DISABLE_CRON',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_AGENT_SDK_MCP_NO_PREFIX',
  'CLAUDE_PREVIEW_CLASSIFIER_FLOOR',
  'AI_AGENT',
  'BAGGAGE',
  'MCP_CONNECTION_NONBLOCKING',
  'MCP_SERVER_CONNECTION_BATCH_SIZE',
] as const;

const DROP = new Set<string>(HOST_SESSION_VARS);

/** The env for the agent under test: `env` minus HOST_SESSION_VARS (names compared case-insensitively, as on Windows). */
export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !DROP.has(k.toUpperCase())));
}

/** The conus server as a whole word in the MCP server name (`conus`, `plugin:conus:conus`), not e.g. `html-tools`. */
const CONUS_SERVER = /(^|[^a-z0-9])conus([^a-z0-9]|$)/i;

export interface StreamSummary {
  sessionId: string | null;
  /** From the `system`/`init` event; null when there was none. */
  mcpServers: { name: string; status: string }[] | null;
  /** Raw status of the conus server ('connected', 'failed', 'pending', …), 'absent' if init lists none, null without init. */
  conusStatus: string | null;
  /** The final `result` event; null when the run produced none (killed, crashed). */
  result: { isError: boolean; subtype: string | null; text: string } | null;
}

/** Parses `claude -p --output-format stream-json --verbose` NDJSON output. */
export function parseStreamJson(stdout: string): StreamSummary {
  let init: any = null;
  let result: any = null;
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let ev: any;
    try { ev = JSON.parse(text); } catch { continue; } // e.g. the last line of a killed run
    if (ev?.type === 'system' && ev.subtype === 'init') init ??= ev;
    else if (ev?.type === 'result') result = ev;
  }
  const mcpServers = init
    ? (Array.isArray(init.mcp_servers) ? init.mcp_servers : []).map((s: any) => ({ name: String(s?.name ?? ''), status: String(s?.status ?? '') }))
    : null;
  const conus = mcpServers?.find((s: { name: string }) => CONUS_SERVER.test(s.name));
  const subtype = typeof result?.subtype === 'string' ? result.subtype : null;
  return {
    sessionId: result?.session_id ?? init?.session_id ?? null,
    mcpServers,
    conusStatus: mcpServers === null ? null : conus ? conus.status : 'absent',
    result: result
      ? { isError: result.is_error === true || !!subtype?.startsWith('error'), subtype, text: typeof result.result === 'string' ? result.result : '' }
      : null,
  };
}
