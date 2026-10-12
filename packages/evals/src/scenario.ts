import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { STATUSES, type Status } from '@conus/core';

const RangeS = z.object({ min: z.number().int().optional(), max: z.number().int().optional() });
const TaskExpS = z.object({
  match: z.object({ title_like: z.string().optional(), seed: z.number().int().optional() }).refine((m) => m.title_like !== undefined || m.seed !== undefined),
  status: z.array(z.enum(STATUSES)).optional(),
  type: z.enum(['task', 'bug']).optional(),
  result: z.literal('non_empty').optional(),
  commits_min: z.number().int().optional(),
  has_parent: z.boolean().optional(),
  source_quote: z.literal('non_empty').optional(),
  max_matching: z.number().int().optional(),
});
const ScenarioS = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  agents: z.array(z.enum(['claude', 'codex'])).default(['claude', 'codex']),
  fixture: z.string(),
  overlay: z.string().optional(),
  manual: z.boolean().default(false),
  seed: z.array(z.object({ title: z.string(), status: z.enum(STATUSES), description: z.string().optional() })).default([]),
  turns: z.array(z.object({ user: z.string().min(1), kill_after_seconds: z.number().int().positive().optional() })).min(1),
  parallel_sessions: z.number().int().min(1).max(2).default(1),
  expect: z.object({
    created: RangeS.optional(),
    proposed: RangeS.optional(),
    tasks: z.array(TaskExpS).default([]),
    max_nudges: z.number().int().default(2),
    janitor_allowed: z.boolean().default(false),
  }),
});

export interface Range { min?: number; max?: number }
export interface TaskExpectation {
  match: { titleLike?: string; seed?: number }; status?: Status[]; type?: 'task' | 'bug'; result?: 'non_empty';
  commitsMin?: number; hasParent?: boolean; sourceQuote?: 'non_empty'; maxMatching?: number;
}
export interface Expectation { created?: Range; proposed?: Range; tasks: TaskExpectation[]; maxNudges: number; janitorAllowed: boolean }
export interface Scenario {
  id: string; description: string; agents: ('claude' | 'codex')[]; fixture: string; overlay?: string; manual: boolean;
  seed: { title: string; status: Status; description?: string }[];
  turns: { user: string; killAfterSeconds?: number }[];
  parallelSessions: number; // 1 = normal; 2 = run the same turns in two concurrent sessions
  expect: Expectation;
}

export function parseScenario(yamlText: string): Scenario {
  const s = ScenarioS.parse(YAML.parse(yamlText));
  return {
    id: s.id, description: s.description, agents: s.agents, fixture: s.fixture, overlay: s.overlay, manual: s.manual, seed: s.seed,
    turns: s.turns.map((t) => ({ user: t.user, ...(t.kill_after_seconds ? { killAfterSeconds: t.kill_after_seconds } : {}) })),
    parallelSessions: s.parallel_sessions,
    expect: {
      created: s.expect.created, proposed: s.expect.proposed, maxNudges: s.expect.max_nudges, janitorAllowed: s.expect.janitor_allowed,
      tasks: s.expect.tasks.map((t) => ({
        match: { titleLike: t.match.title_like, seed: t.match.seed }, status: t.status, type: t.type, result: t.result,
        commitsMin: t.commits_min, hasParent: t.has_parent, sourceQuote: t.source_quote, maxMatching: t.max_matching,
      })),
    },
  };
}

export function loadScenarios(dir: string): Scenario[] {
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort().map((f) => parseScenario(readFileSync(join(dir, f), 'utf8')));
}
