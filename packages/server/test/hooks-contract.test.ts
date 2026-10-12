import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
// conus must not import the server, so the contract lives here: conus source in, server schemas out.
import { activityBody, endBody, promptBody, startBody, stopBody } from '../../cli/src/hook/bodies';
import { claudeCallCommits, extractFacts, repoRelativeDir } from '../../cli/src/hook/facts';
import { normalizeHookInput, type AgentFlavor, type HookInput } from '../../cli/src/hook/normalize';
import { lastAssistantText } from '../../cli/src/hook/transcript';
import type { RepoContext } from '../../cli/src/git';
import { ActivityBody, EndBody, PromptBody, StartBody, StopBody } from '../src/routes/hooks';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../cli/test/fixtures');
const transcript = join(fixtures, 'claude/transcript.jsonl');
const load = (agent: AgentFlavor, name: string, patch: Record<string, unknown> = {}): HookInput => {
  const raw = JSON.parse(readFileSync(join(fixtures, agent, `${name}.json`), 'utf8').replace('__TRANSCRIPT__', transcript.replace(/\\/g, '\\\\')));
  return normalizeHookInput(agent, { ...raw, ...patch })!;
};
const SHA = 'a'.repeat(40);
const repoOf = (input: HookInput, over: Partial<RepoContext> = {}): RepoContext => ({
  root: input.cwd, rootName: 'repo', rootPathHash: 'f'.repeat(64), remote: 'git@github.com:me/repo.git', branch: 'main', head: SHA, ...over,
});
// As run.ts calls it: Claude commits of this repo (named by gitOperation, or in the call's reflog window), Codex
// commits from the new HEAD.
const factsOf = (agent: AgentFlavor, input: HookInput, subject = 'feat: csv import') =>
  extractFacts(input, input.cwd, {
    assumeSuccess: agent === 'claude', commits: agent === 'claude' ? 'claude' : 'head',
    claudeCommits: (call) => claudeCallCommits({ ...call, window: null }, { reflog: null, resolve: (sha) => ({ sha: sha.padEnd(40, '0'), subject }) }),
    headCommit: () => ({ sha: 'b'.repeat(40), subject }), amends: () => SHA,
  });

/** Parses with the server's schema and fails with the zod issues, so a broken contract names its field. */
function accepts<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const r = schema.safeParse(JSON.parse(JSON.stringify(body)));
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return r.data;
}
// JSON.stringify writes a lone surrogate as a \udXXX escape (a whole pair stays raw); Postgres jsonb rejects those.
const noLoneSurrogates = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);

describe('conus → server hook contract (recorded fixtures)', () => {
  it.each(['claude', 'codex'] as const)('%s: every body conus builds is accepted by the server schema', (agent) => {
    const start = load(agent, 'session-start');
    accepts(StartBody, startBody(start, repoOf(start), repoRelativeDir(start.cwd, start.cwd)));
    accepts(PromptBody, promptBody(load(agent, 'prompt'), true));
    accepts(PromptBody, promptBody(load(agent, 'prompt'), false));
    const tools = agent === 'claude' ? ['tool-edit', 'tool-bash-commit', 'tool-bash-test', 'tool-bash-write', 'tool-mcp'] : ['tool-patch', 'tool-shell'];
    for (const name of tools) {
      const input = load(agent, name);
      const facts = factsOf(agent, input);
      expect(facts.length, name).toBeGreaterThan(0);
      expect(accepts(ActivityBody, activityBody(input, facts, 'k'.repeat(40))).facts, name).toHaveLength(facts.length);
    }
    const stops = agent === 'claude' ? ['stop', 'stop-transcript-only'] : ['stop'];
    for (const name of stops) {
      const input = load(agent, name);
      const answer = input.lastAssistantMessage ?? (input.transcriptPath ? lastAssistantText(input.transcriptPath) : null);
      const commit = { sha: 'c'.repeat(40), subject: 'feat: x', branch: 'main', amends: SHA };
      const parsed = accepts(StopBody, stopBody(input, { answer, model: 'claude-opus-5', commits: [commit] }));
      expect(parsed.facts, name).toEqual([{ kind: 'git_commit', data: commit }]);
      accepts(StopBody, stopBody(input, { answer: null, model: null }));
    }
    accepts(EndBody, endBody(load(agent, 'session-end'), 'e'.repeat(40)));
  });

  it('oversized fields are clamped to the server limits, never splitting a surrogate pair', () => {
    const emojiAt = (n: number) => 'x'.repeat(n - 1) + '😀'.repeat(20); // a pair straddles every limit
    const id = emojiAt(200);
    const start = load('codex', 'session-start', { session_id: id, model: emojiAt(100) });
    const longRepo = repoOf(start, { remote: emojiAt(500), rootName: emojiAt(200), branch: emojiAt(200), head: emojiAt(64), rootPathHash: emojiAt(128) });
    const s = startBody(start, longRepo, emojiAt(1000));
    const ps = accepts(StartBody, s);
    expect(ps.agent_session_id.length).toBeLessThanOrEqual(200);
    expect(ps.model!.length).toBeLessThanOrEqual(100);
    expect(ps.repo.branch!.length).toBeLessThanOrEqual(200);
    noLoneSurrogates(s);

    const prompt = promptBody(load('claude', 'prompt', { session_id: id, prompt: emojiAt(2000) }), true);
    expect(accepts(PromptBody, prompt).prompt_excerpt!.length).toBeLessThanOrEqual(2000);
    noLoneSurrogates(prompt);

    const tool = load('claude', 'tool-bash-test', { session_id: id, tool_input: { command: `npm test -- ${emojiAt(400)}` } });
    const activity = activityBody(tool, factsOf('claude', tool), 'k'.repeat(40));
    accepts(ActivityBody, activity);
    noLoneSurrogates(activity);
    const commitTool = load('claude', 'tool-bash-commit', { session_id: id });
    const commitActivity = activityBody(commitTool, factsOf('claude', commitTool, emojiAt(300)), 'k'.repeat(40));
    accepts(ActivityBody, commitActivity);
    noLoneSurrogates(commitActivity);

    const stop = stopBody(load('claude', 'stop', { session_id: id, last_assistant_message: '😀'.repeat(1500) }), {
      answer: '😀'.repeat(1500), model: emojiAt(100), commits: [{ sha: 'c'.repeat(40), subject: emojiAt(300), branch: emojiAt(200) }],
    });
    const pstop = accepts(StopBody, stop);
    expect(pstop.answer_excerpt!.length).toBeLessThanOrEqual(2000);
    expect(pstop.model!.length).toBeLessThanOrEqual(100);
    noLoneSurrogates(stop);

    const end = endBody(load('claude', 'session-end', { session_id: id, reason: emojiAt(100) }), 'e'.repeat(40));
    expect(accepts(EndBody, end).reason!.length).toBeLessThanOrEqual(100);
    noLoneSurrogates(end);
  });
});
