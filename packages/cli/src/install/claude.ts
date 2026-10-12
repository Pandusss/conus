import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Translate } from '../i18n';

export const DEFAULT_MARKETPLACE = 'Pandusss/conus';
export const PLUGIN = 'conus@conus';
const MARKETPLACE_NAME = 'conus';

export type Run = (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string };

export function claudeInstallInstructions(marketplace: string, t: Translate): string {
  return [
    t('In Claude Code, run:', 'В Claude Code выполни:'),
    `  /plugin marketplace add ${marketplace}`,
    `  /plugin install ${PLUGIN}`,
    t('Then restart Claude Code.', 'Затем перезапусти Claude Code.'),
  ].join('\n');
}

/** Whether the `claude` CLI answers on this machine. */
export function claudeCliAvailable(run: Run): boolean {
  try { return run('claude', ['--version']).code === 0; } catch { return false; }
}

/**
 * Adds the Conus marketplace (a no-op when it is already there), refreshes its listing and installs the plugin
 * through the `claude` CLI. Returns null on success, else what went wrong (the caller then prints the in-app commands).
 */
export function installClaudePlugin(run: Run, marketplace: string): string | null {
  const said = (r: ReturnType<Run>) => `${r.stdout}\n${r.stderr}`.trim();
  const add = run('claude', ['plugin', 'marketplace', 'add', marketplace]);
  if (add.code !== 0) return said(add) || `claude plugin marketplace add exited ${add.code}`;
  run('claude', ['plugin', 'marketplace', 'update', MARKETPLACE_NAME]);
  const install = run('claude', ['plugin', 'install', PLUGIN, '--scope', 'user']);
  if (install.code !== 0) return said(install) || `claude plugin install exited ${install.code}`;
  return null;
}

export function claudePluginInstalled(claudeDir: string): boolean {
  for (const f of [join(claudeDir, 'plugins', 'installed_plugins.json'), join(claudeDir, 'settings.json')]) {
    try { if (existsSync(f) && readFileSync(f, 'utf8').includes(PLUGIN)) return true; } catch { /* ignore */ }
  }
  return false;
}
