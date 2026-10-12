import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil';

export interface ConusConfig { url: string; token: string; sendText: boolean }

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONUS_CONFIG_DIR || join(homedir(), '.conus');
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ConusConfig | null {
  const file = join(configDir(env), 'config.json');
  let parsed: unknown = null;
  if (existsSync(file)) {
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { parsed = null; }
  }
  // Valid JSON that is not an object (null, [], 5, "x") is treated as an empty config.
  const raw: Record<string, unknown> = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  const url = typeof raw.url === 'string' ? raw.url : '';
  const token = typeof raw.token === 'string' ? raw.token : '';
  // send_text is honoured only when it is a real boolean; anything else (e.g. the string "false") means the default, true.
  const sendText = typeof raw.send_text === 'boolean' ? raw.send_text : true;
  if (env.CONUS_URL && env.CONUS_TOKEN) return { url: env.CONUS_URL, token: env.CONUS_TOKEN, sendText };
  if (!url || !token) return null;
  return { url, token, sendText };
}

export function writeConfig(cfg: ConusConfig, env: NodeJS.ProcessEnv = process.env): void {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, 'config.json'), JSON.stringify({ url: cfg.url, token: cfg.token, send_text: cfg.sendText }, null, 2), 0o600);
}

export function updateConfig(patch: Partial<ConusConfig>, env: NodeJS.ProcessEnv = process.env): ConusConfig {
  const cur = readConfig({ CONUS_CONFIG_DIR: configDir(env) });
  if (!cur) throw new Error('Not logged in: run `conus login <url> <token>` first.');
  const next = { ...cur, ...patch };
  writeConfig(next, env);
  return next;
}
