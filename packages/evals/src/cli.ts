import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTask, ownerSetStatus, resolveOrCreateProject, runJanitor, NullJudge } from '@conus/core';
import { collectState, countSessions, startHarness } from './harness';
import { invalidReason } from './outcome';
import { cliVersion } from './proc';
import { prepareRepo, shimDir } from './repo';
import { renderReport, resultStatus, type ScenarioResult } from './report';
import { runClaude } from './run-claude';
import { runCodex } from './run-codex';
import { loadScenarios } from './scenario';
import { scoreScenario } from './score';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const agent = (opt('--agent') ?? 'claude') as 'claude' | 'codex';
const only = opt('--only')?.split(',');
const includeManual = argv.includes('--manual');
if (agent !== 'claude' && agent !== 'codex') throw new Error(`--agent must be claude or codex, got ${agent}`);

const scenarios = loadScenarios(join(here, '../scenarios'))
  .filter((s) => s.agents.includes(agent) && (includeManual || !s.manual) && (!only || only.includes(s.id)));
if (!scenarios.length) {
  console.error(`No scenarios selected (agent ${agent}${only ? `, --only ${only.join(',')}` : ''}${includeManual ? '' : ', manual ones need --manual'}).`);
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), 'conus-evals-'));
const shim = shimDir(work);
// Windows keeps PATH as `Path`; prepend to whichever key exists so the child sees exactly one.
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
const h = await startHarness();
const meta = {
  agent,
  model: (agent === 'claude' ? process.env.EVAL_CLAUDE_MODEL : undefined) || 'default',
  agentVersion: cliVersion(agent),
  judge: h.judgeEnabled,
  isolated: agent === 'codex' || process.env.EVAL_ISOLATED !== 'false', // Codex always runs with a throwaway CODEX_HOME
  date: new Date(),
};
console.log(`${meta.agent} ${meta.agentVersion} · model ${meta.model} · judge ${meta.judge ? 'on' : 'off'} · isolation ${meta.isolated ? 'on' : 'off'}`);
const results: ScenarioResult[] = [];
try {
  for (const s of scenarios) {
    console.log(`▶ ${s.id} (${agent})`);
    try {
      const repo = prepareRepo(s, work);
      const { project } = await resolveOrCreateProject(h.db, { remote: repo.remote, rootName: s.id, rootPathHash: 'eval' });
      const seededIds: string[] = [];
      for (const seed of s.seed) {
        const r = await createTask({ db: h.db, actor: { kind: 'user' } }, { projectId: project.id, title: seed.title, description: seed.description, confirmNew: { reason: 'seed' } });
        if (r.outcome !== 'created') throw new Error('seed failed');
        if (seed.status !== 'todo') await ownerSetStatus({ db: h.db, actor: { kind: 'user' } }, { taskId: r.task.id, status: seed.status });
        seededIds.push(r.task.id);
      }
      const configDir = join(work, 'conus-config', s.id);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ url: h.url, token: h.token, send_text: true }));
      const env = { ...process.env, CONUS_URL: h.url, CONUS_TOKEN: h.token, CONUS_CONFIG_DIR: configDir, [pathKey]: `${shim}${delimiter}${process.env[pathKey] ?? ''}` };
      const run = agent === 'claude' ? await runClaude(s, repo.dir, env) : await runCodex(s, repo.dir, env);
      writeFileSync(join(work, `${s.id}.transcript.txt`), run.transcript.join('\n\n'));
      const sessions = await countSessions(h, project.id);
      // The agent's sessions have ended: nothing it created or touched may still be in_progress (the `in_progress` check).
      const atSessionEnd = await collectState(h, project.id, seededIds);
      // Reconcile as if 31 minutes passed: stale sessions, release claims left behind (scored by the `janitor` check).
      await runJanitor({ db: h.db, judge: new NullJudge() }, new Date(Date.now() + 31 * 60_000));
      const state = await collectState(h, project.id, seededIds);
      const result: ScenarioResult = {
        scenario: s, agent, ...scoreScenario(s, state, atSessionEnd), state, invalid: invalidReason(run.turns, sessions, s.parallelSessions),
      };
      results.push(result);
      const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');
      const label = { pass: 'PASS', fail: 'FAIL', invalid: '⚠️ INVALID', error: 'ERROR' }[resultStatus(result)];
      console.log(`  ${label} sessions=${sessions} ${result.invalid ? `(${result.invalid}) ` : ''}${failed}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      results.push({ scenario: s, agent, passed: false, checks: [], state: null, error });
      console.log(`  ERROR ${error}`);
    }
  }
} finally {
  try { await h.stop(); } catch (e) { console.error('harness stop failed', e); }
  const report = renderReport(results, meta);
  const out = join(here, '../reports', `${meta.date.toISOString().replace(/[:.]/g, '-')}-${agent}.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report);
  console.log(`\nReport: ${out}\nTranscripts: ${work}`);
}
