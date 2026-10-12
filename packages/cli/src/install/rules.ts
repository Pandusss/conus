import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_MD_END, AGENTS_MD_START, GLOBAL_RULES_BLOCK } from '@conus/protocol';
import { assertBlockSane, upsertBlock } from './agents-md';

export interface RuleTarget { agent: string; file: string; create: boolean }

/** Global instruction files of the agents conus knows; a missing file is created only when its agent's home exists. */
export function globalRuleTargets(home: string, codexHome: string): RuleTarget[] {
  return [
    { agent: 'Claude Code', file: join(home, '.claude', 'CLAUDE.md'), create: existsSync(join(home, '.claude')) },
    { agent: 'Codex', file: join(codexHome, 'AGENTS.md'), create: existsSync(codexHome) },
    { agent: 'Gemini CLI', file: join(home, '.gemini', 'GEMINI.md'), create: existsSync(join(home, '.gemini')) },
  ];
}

/** Upserts the global rules block into every target; checks all of them first so a refusal changes nothing. */
export function installRules(targets: RuleTarget[]) {
  for (const t of targets) assertBlockSane(t.file, AGENTS_MD_START, AGENTS_MD_END);
  return targets.map((t) => ({ ...t, result: upsertBlock(t.file, GLOBAL_RULES_BLOCK, AGENTS_MD_START, AGENTS_MD_END, t.create) }));
}
