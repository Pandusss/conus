/** What one agent turn (one CLI invocation) produced, as far as validity is concerned. */
export interface TurnOutcome {
  session: number; // 1-based; parallel sessions get 1, 2
  turn: number; // 1-based
  hasResult: boolean; // a final result was parsed
  isError: boolean;
  errorDetail: string | null;
  killed: boolean;
  plannedKill: boolean; // the scenario turn had kill_after_seconds
  /** Raw conus MCP status from the agent ('connected', 'failed', 'absent', null = no init event); undefined = runner cannot observe MCP. */
  mcpStatus?: string | null;
}

export interface AgentRun { sessionIds: string[]; transcript: string[]; turns: TurnOutcome[] }

/**
 * Why a run cannot be scored (the agent or its wiring failed, so the result says nothing about agent behaviour),
 * or null when it is valid. `expectedSessions` is the scenario's `parallelSessions`: each concurrent agent session
 * must reach the server.
 */
export function invalidReason(turns: TurnOutcome[], serverSessions: number, expectedSessions: number): string | null {
  const why: string[] = [];
  if (serverSessions < expectedSessions) why.push(`server recorded ${serverSessions} hook session(s) for the project, expected ${expectedSessions}`);
  if (!turns.length) why.push('agent ran no turns');
  for (const t of turns) {
    const at = `s${t.session}t${t.turn}`;
    if (t.killed && !t.plannedKill) why.push(`${at}: killed by the runner timeout`);
    else if (!t.killed && !t.hasResult) why.push(`${at}: no parseable final result`);
    if (t.isError) why.push(`${at}: is_error${t.errorDetail ? ` (${t.errorDetail})` : ''}`);
    if (t.mcpStatus !== undefined && t.mcpStatus !== 'connected') why.push(`${at}: conus MCP ${t.mcpStatus ?? 'no init event'}`);
  }
  return why.length ? why.join('; ') : null;
}
