import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ApiError, createApi } from './api-client';
import type { CliIO } from './cli';
import { readConfig } from './config';
import { repoContext } from './git';
import { endBody, startBody } from './hook/bodies';
import { repoRelativeDir } from './hook/facts';
import { normalizeHookInput } from './hook/normalize';
import type { Translate } from './i18n';
import { claudePluginInstalled } from './install/claude';
import { codexStatus } from './install/codex';
import { geminiInstalled } from './install/gemini';

export interface Check { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Whether `name` is on PATH the way a shell finds it (npm installs `conus.cmd` on Windows). */
export function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const path = env.PATH ?? env.Path ?? '';
  const exts = platform === 'win32' ? ['.cmd', '.exe', '.ps1', ''] : [''];
  const sep = platform === 'win32' ? ';' : delimiter;
  return path.split(sep).filter(Boolean).some((dir) => exts.some((ext) => existsSync(join(dir, name + ext))));
}

export async function runDoctor(io: CliIO, home: string, t: Translate): Promise<Check[]> {
  const checks: Check[] = [];
  const cfg = readConfig(io.env);
  if (!cfg) {
    checks.push({ name: 'config', status: 'fail', detail: t('not set up: run conus setup', 'не настроено: запусти conus setup') });
    return checks;
  }
  checks.push({ name: 'config', status: 'ok', detail: cfg.url });
  const api = createApi(cfg, io.fetchImpl);
  try { await api.get('/healthz', 5000); checks.push({ name: 'server', status: 'ok', detail: t('reachable', 'доступен') }); }
  catch (e) { checks.push({ name: 'server', status: 'fail', detail: `${t('unreachable', 'недоступен')}: ${message(e)}` }); }
  try {
    const w = await api.get<{ agent: { name: string } }>('/api/hooks/whoami', 5000);
    checks.push({ name: 'token', status: 'ok', detail: `${t('agent', 'агент')} ${w.agent.name}` });
  } catch (e) {
    checks.push(e instanceof ApiError && (e.status === 401 || e.status === 403)
      ? { name: 'token', status: 'fail', detail: t('the server rejected the token (revoked?)', 'токен отклонён сервером (отозван?)') }
      : { name: 'token', status: 'fail', detail: `${t('could not check the token', 'не удалось проверить токен')}: ${message(e)}` });
  }
  checks.push(onPath('conus', io.env, io.platform)
    ? { name: 'path', status: 'ok', detail: t('conus is on PATH', 'conus есть в PATH') }
    : { name: 'path', status: 'warn', detail: t(
      'conus is not on PATH: agent hooks cannot start it. Add the npm global bin directory (npm prefix -g) to PATH',
      'conus нет в PATH: хуки агентов не смогут его запустить. Добавь каталог глобальных пакетов npm (npm prefix -g) в PATH') });
  const claudeDir = join(home, '.claude');
  if (existsSync(claudeDir)) {
    checks.push(claudePluginInstalled(claudeDir)
      ? { name: 'claude', status: 'ok', detail: t('conus plugin installed', 'плагин conus установлен') }
      : { name: 'claude', status: 'warn', detail: t('plugin not found: conus install claude', 'плагин не найден: conus install claude') });
  }
  const codexHome = io.env.CODEX_HOME || join(home, '.codex');
  if (existsSync(codexHome)) {
    const s = codexStatus(codexHome, join(home, '.agents', 'skills'));
    if (!s.config || !s.hooks || !s.skill) checks.push({ name: 'codex', status: 'warn', detail: t('not installed: conus install codex', 'не установлено: conus install codex') });
    else if (!s.trustedHint) checks.push({ name: 'codex', status: 'warn', detail: t('installed; approve the hooks in Codex with /hooks', 'установлено; одобри хуки в Codex через /hooks') });
    else checks.push({ name: 'codex', status: 'ok', detail: t('MCP, hooks and skill in place', 'MCP, хуки и скилл на месте') });
  }
  const geminiHome = join(home, '.gemini');
  if (existsSync(geminiHome)) {
    checks.push(geminiInstalled(geminiHome)
      ? { name: 'gemini', status: 'ok', detail: t('conus MCP server configured', 'MCP-сервер conus настроен') }
      : { name: 'gemini', status: 'warn', detail: t('not installed: conus install gemini', 'не установлено: conus install gemini') });
  }
  const repo = repoContext(io.cwd);
  if (repo) {
    // Built like the hook runner's bodies (clamped to the server limits); cwd is repo-relative: no absolute path leaves the machine.
    const input = normalizeHookInput('claude', { session_id: `doctor-${Date.now()}`, cwd: io.cwd, source: 'startup', reason: 'doctor' })!;
    try {
      await api.post('/api/hooks/session/start', startBody(input, repo, repoRelativeDir(repo.root, io.cwd)), 5000);
      await api.post('/api/hooks/session/end', endBody(input, null), 5000);
      checks.push({ name: 'roundtrip', status: 'ok', detail: t(`test session in ${repo.rootName} went through`, `тестовая сессия в ${repo.rootName} прошла`) });
    } catch (e) {
      checks.push({ name: 'roundtrip', status: 'fail', detail: message(e) });
    }
  }
  return checks;
}
