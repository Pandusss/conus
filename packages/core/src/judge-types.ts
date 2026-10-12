import type { Status } from './types';

export interface TaskBrief { ref: string; title: string; status: Status }
export interface JudgeInput {
  prompt: string | null;
  answer: string | null;
  activity: { files: string[]; commits: { sha: string; subject: string }[]; tests: { passed: boolean | null }[] };
  turnTaskOps: string[];
  sessionTasks: TaskBrief[];
  openTasks: TaskBrief[];
}
export interface JudgeVerdict { verdict: 'ok' | 'nudge'; reason: string; taskRefs: string[] }
export interface SummaryInput {
  task: { ref: string; title: string; description: string };
  commits: { sha: string; subject: string }[];
  files: string[];
  lastAnswer: string | null;
}
export interface Judge {
  readonly enabled: boolean;
  evaluate(input: JudgeInput): Promise<JudgeVerdict>;
  summarize(input: SummaryInput): Promise<string | null>;
}

export const OK_VERDICT: JudgeVerdict = { verdict: 'ok', reason: '', taskRefs: [] };

export class NullJudge implements Judge {
  readonly enabled = false;
  async evaluate(): Promise<JudgeVerdict> { return OK_VERDICT; }
  async summarize(): Promise<string | null> { return null; }
}
