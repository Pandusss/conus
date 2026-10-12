import { createJudgeFromEnv, parseLang, type Judge, type Lang } from '@conus/core';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ServerConfig {
  databaseUrl: string; port: number; host: string; publicUrl: string; uiDir: string | null;
  cookieSecure: boolean; janitorIntervalMs: number; judge: Judge;
  /** The language of what the server writes for people (CONUS_LANG): chat notes, status line, task history. */
  lang: Lang;
  /** First-run setup code from CONUS_SETUP_CODE (an installer can generate and show it); random when unset. */
  setupCode?: string | null;
}

/** Largest delay setInterval honours; bigger values silently become 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Positive integer env var. Unset or empty (docker compose passes `${X:-}` as "") means "use the default";
 * a non-numeric, non-integer, <= 0 or too large value also falls back, with a warning so a typo is visible.
 */
function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && n <= max) return n;
  console.warn(`[conus] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const port = positiveInt(env, 'PORT', 8080, 65535);
  const publicUrl = env.PUBLIC_URL || `http://localhost:${port}`;
  const defaultUi = resolve(process.cwd(), 'packages/ui/dist');
  const uiDir = env.CONUS_UI_DIR || (existsSync(defaultUi) ? defaultUi : null);
  return {
    databaseUrl, port, host: env.HOST || '0.0.0.0', publicUrl, uiDir,
    cookieSecure: publicUrl.startsWith('https://'),
    janitorIntervalMs: positiveInt(env, 'CONUS_JANITOR_INTERVAL_MS', 300_000, MAX_TIMER_MS),
    judge: createJudgeFromEnv(env),
    lang: parseLang(env.CONUS_LANG),
    setupCode: env.CONUS_SETUP_CODE?.trim() || null,
  };
}
