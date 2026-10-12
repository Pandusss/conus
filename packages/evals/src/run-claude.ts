import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentEnv, parseStreamJson } from './claude-stream';
import type { AgentRun, TurnOutcome } from './outcome';
import { runProcess } from './proc';
import { repoRoot } from './repo';
import type { Scenario } from './scenario';

const excerpt = (s: string, n = 200) => s.replace(/\s+/g, ' ').trim().slice(0, n);

export async function runClaude(s: Scenario, repoDir: string, env: NodeJS.ProcessEnv): Promise<AgentRun> {
  const pluginDir = join(repoRoot, 'integrations', 'claude-code');
  // Never `--bare`: it skips hooks and plugins, i.e. everything under test.
  // stream-json (needs --verbose) carries the init event with the MCP server statuses, and survives a kill.
  const base = ['-p', '--output-format', 'stream-json', '--verbose', '--plugin-dir', pluginDir, '--dangerously-skip-permissions'];
  // Only project/local settings: the user's own plugins and hooks must not change agent behaviour in evals.
  if (process.env.EVAL_ISOLATED !== 'false') base.push('--setting-sources', 'project,local');
  if (process.env.EVAL_CLAUDE_MODEL) base.push('--model', process.env.EVAL_CLAUDE_MODEL);
  const cenv = agentEnv(env);
  const runSession = async (session: number) => {
    let sessionId: string | null = null;
    const transcript: string[] = [];
    const turns: TurnOutcome[] = [];
    for (const [i, turn] of s.turns.entries()) {
      const args = [...base, ...(sessionId ? ['--resume', sessionId] : [])];
      // The prompt goes through stdin: no shell quoting, and Cyrillic survives cmd.exe on win32.
      const { stdout, stderr, killed, code } = await runProcess('claude', args, { cwd: repoDir, env: cenv, input: turn.user, killAfterSeconds: turn.killAfterSeconds });
      writeFileSync(`${repoDir}.s${session}t${i + 1}.jsonl`, stdout); // raw stream (tool calls) for debugging, next to the repo
      const out = parseStreamJson(stdout);
      sessionId = out.sessionId ?? sessionId;
      const r = out.result;
      turns.push({
        session, turn: i + 1, hasResult: !!r, isError: !!r?.isError, errorDetail: r?.isError ? excerpt(r.text || r.subtype || '') || null : null,
        killed, plannedKill: turn.killAfterSeconds !== undefined, mcpStatus: out.conusStatus,
      });
      const head = `USER: ${turn.user}\nAGENT [s${session}t${i + 1} conus-mcp: ${out.conusStatus ?? 'no init'}]`;
      if (r) transcript.push(`${head}${r.isError ? ' (error)' : ''}: ${r.text}`);
      else transcript.push(`${head}: ${killed ? '(killed)' : `(no result event, exit ${code})`}${stderr ? `\nSTDERR: ${stderr.slice(-2000)}` : ''}`);
      if (killed) break;
    }
    return { sessionId, transcript, turns };
  };
  const runs = await Promise.all(Array.from({ length: s.parallelSessions }, (_, i) => runSession(i + 1)));
  return {
    sessionIds: runs.map((r) => r.sessionId).filter((x): x is string => !!x),
    transcript: runs.flatMap((r) => r.transcript),
    turns: runs.flatMap((r) => r.turns),
  };
}
