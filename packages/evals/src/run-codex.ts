import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCodex } from '../../cli/src/install/codex';
import type { AgentRun, TurnOutcome } from './outcome';
import { runProcess } from './proc';
import type { Scenario } from './scenario';

// Built for completeness; unverified until a machine with the Codex CLI runs it (Task 21).
export async function runCodex(s: Scenario, repoDir: string, env: NodeJS.ProcessEnv): Promise<AgentRun> {
  // A throwaway CODEX_HOME: the Conus MCP server, hooks and skill are installed there, never into the user's ~/.codex.
  const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
  try {
    installCodex({ codexHome, skillsDir: join(codexHome, 'skills'), platform: process.platform });
    const auth = join(homedir(), '.codex', 'auth.json');
    if (existsSync(auth)) copyFileSync(auth, join(codexHome, 'auth.json'));
    const cenv = { ...env, CODEX_HOME: codexHome };
    let threadId: string | null = null;
    const transcript: string[] = [];
    const turns: TurnOutcome[] = [];
    for (const [i, turn] of s.turns.entries()) {
      // `-` reads the prompt from stdin (no shell quoting on win32).
      const args = threadId
        ? ['exec', 'resume', threadId, '--json', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '-']
        : ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '-C', repoDir, '-'];
      const { stdout, stderr, killed, code } = await runProcess('codex', args, { cwd: repoDir, env: cenv, input: turn.user, killAfterSeconds: turn.killAfterSeconds });
      transcript.push(`USER: ${turn.user}`);
      let answered = false;
      let completed = false;
      let error: string | null = null;
      for (const line of stdout.split('\n')) {
        try {
          const ev = JSON.parse(line);
          threadId = ev.thread_id ?? ev.session_id ?? threadId;
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') { transcript.push(`AGENT: ${ev.item.text}`); answered = true; }
          if (ev.type === 'turn.completed') completed = true;
          if (ev.type === 'turn.failed' || ev.type === 'error') error = String(ev.error?.message ?? ev.message ?? ev.type).slice(0, 200);
        } catch { /* non-JSON line */ }
      }
      if (!answered) transcript.push(`AGENT: ${killed ? '(killed)' : `(no agent message, exit ${code})`}${stderr ? `\nSTDERR: ${stderr.slice(-2000)}` : ''}`);
      // The conus MCP status is not observable from `codex exec --json`, so mcpStatus stays undefined.
      turns.push({
        session: 1, turn: i + 1, hasResult: completed || answered, isError: error !== null, errorDetail: error,
        killed, plannedKill: turn.killAfterSeconds !== undefined,
      });
      if (killed) break;
    }
    return { sessionIds: threadId ? [threadId] : [], transcript, turns };
  } finally {
    // Cleanup must never turn a finished run into an ERROR (e.g. a file still locked on win32).
    try { rmSync(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (e) { console.warn(`could not remove ${codexHome}:`, e instanceof Error ? e.message : e); }
  }
}
