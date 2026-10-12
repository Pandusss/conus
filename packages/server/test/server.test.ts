import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../../../test/helpers/db';
import { createAgent, NullJudge } from './test-imports';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { startServer } from '../src/server';
import { loadConfig } from '../src/config';
import { serveUi } from '../src/static';
import { AGENT_RATE_LIMIT } from '../src/rate-limit';

const SECRET = 'TOP-SECRET-CONTENTS';
let srv: Awaited<ReturnType<typeof startServer>>;
let drop: () => Promise<void>;
let ui: string;
beforeAll(async () => {
  const t = await createTestDb();
  drop = t.drop;
  // base/ui is the served dir; base/secret and base/ui-evil/secret.txt sit beside it and must never be reachable.
  const base = mkdtempSync(join(tmpdir(), 'conus-ui-'));
  ui = join(base, 'ui');
  mkdirSync(join(ui, 'assets'), { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>conus</title>');
  writeFileSync(join(ui, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(base, 'secret'), SECRET);
  mkdirSync(join(base, 'ui-evil'));
  writeFileSync(join(base, 'ui-evil', 'secret.txt'), SECRET);
  srv = await startServer({ databaseUrl: t.url, port: 0, host: '127.0.0.1', publicUrl: 'http://localhost', uiDir: ui, cookieSecure: false, janitorIntervalMs: 60_000, judge: new NullJudge(), lang: 'en' });
});
afterAll(async () => { await srv.close(); await drop(); });

describe('server', () => {
  it('serves health, protects APIs and MCP, serves UI with SPA fallback', async () => {
    expect((await fetch(`${srv.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${srv.url}/api/hooks/whoami`)).status).toBe(401);
    expect((await fetch(`${srv.url}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
    const html = await fetch(`${srv.url}/tasks/123`);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).toContain('<title>conus</title>');
    const js = await fetch(`${srv.url}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${srv.url}/assets/../../secret`)).status).not.toBe(500);
  });

  it('caches only real /assets files as immutable; SPA routes are no-cache', async () => {
    const asset = await fetch(`${srv.url}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await asset.text()).toBe('console.log(1)');

    const route = await fetch(`${srv.url}/tasks/123`);
    expect(route.status).toBe(200);
    expect(route.headers.get('cache-control')).toBe('no-cache');
    expect(await route.text()).toContain('<title>conus</title>');

    const root = await fetch(`${srv.url}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('cache-control')).toBe('no-cache');
  });

  it('404s a missing asset or file instead of serving the SPA index (and never marks it immutable)', async () => {
    for (const p of ['/assets/missing.js', '/assets/missing', '/assets/', '/missing.png', '/favicon.ico', '/robots.txt']) {
      const r = await fetch(`${srv.url}${p}`);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toContain('application/json');
      expect(r.headers.get('cache-control') ?? '', p).not.toContain('immutable');
      expect(await r.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
  });

  it('hooks and MCP share one budget of AGENT_RATE_LIMIT requests a minute per agent token', async () => {
    const { token } = await createAgent(srv.db, { name: 'rl-shared@test', kind: 'claude_code' });
    const auth = { Authorization: `Bearer ${token}` };
    for (let i = 0; i < AGENT_RATE_LIMIT - 1; i++) expect((await fetch(`${srv.url}/api/hooks/whoami`, { headers: auth })).status).toBe(200);
    const init = {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'rl', version: '0' } } }),
    };
    const ok = await fetch(`${srv.url}/mcp`, init); // the last request within the budget
    await ok.text();
    expect(ok.status).toBe(200);
    expect((await fetch(`${srv.url}/api/hooks/whoami`, { headers: auth })).status).toBe(429);
    const mcp = await fetch(`${srv.url}/mcp`, init);
    expect(mcp.status).toBe(429);
    expect(((await mcp.json()) as { jsonrpc: string }).jsonrpc).toBe('2.0');
  });

  it('unknown /api paths are JSON 404s, not the SPA', async () => {
    const r = await fetch(`${srv.url}/api/nope`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
  });
});

describe('serveUi', () => {
  it('never escapes the UI dir via encoded traversal', async () => {
    const serve = serveUi(ui);
    const attempts = [
      '/..%2fsecret',
      '/..%2Fsecret',
      '/assets/..%2f..%2fsecret',
      '/..%5csecret',
      '/%2e%2e/secret',
      '/..%2fui-evil%2fsecret.txt', // sibling dir sharing the "ui" prefix
      '/assets/..%2f..%2fui-evil%2fsecret.txt',
      '/../secret',
    ];
    for (const p of attempts) {
      const r = await serve(p);
      expect(r?.body.toString() ?? '', p).not.toContain(SECRET);
    }
    // the ones with an extension or under /assets/ are hard 404s, the extension-less ones only get the SPA index
    expect(await serve('/assets/..%2f..%2fsecret')).toBeNull();
    expect(await serve('/..%2fui-evil%2fsecret.txt')).toBeNull();
    expect((await serve('/..%2fsecret'))?.body.toString()).toContain('<title>conus</title>');
  });

  it('classifies responses: file, immutable asset, SPA route, missing asset, malformed escape, reserved paths', async () => {
    const serve = serveUi(ui);
    expect(await serve('/assets/app.js')).toMatchObject({ status: 200, immutable: true });
    expect(await serve('/index.html')).toMatchObject({ status: 200, immutable: false });
    expect(await serve('/assets/../index.html')).toMatchObject({ status: 200, immutable: false });
    expect(await serve('/tasks/123')).toMatchObject({ status: 200, immutable: false, type: expect.stringContaining('text/html') });
    expect(await serve('/assets/missing.js')).toBeNull();
    expect(await serve('/missing.css')).toBeNull();
    expect(await serve('/%E0%A4%A')).toBeNull();
    expect(await serve('/api/anything')).toBeNull();
    expect(await serve('/mcp')).toBeNull();
    expect(await serve('/healthz')).toBeNull();
  });
});

describe('loadConfig', () => {
  const base = { DATABASE_URL: 'postgres://x' };

  it('requires DATABASE_URL and derives cookieSecure from PUBLIC_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    const c = loadConfig({ DATABASE_URL: 'postgres://x', PUBLIC_URL: 'https://conus.example.com' });
    expect(c.cookieSecure).toBe(true);
    expect(c.port).toBe(8080);
    expect(c.lang).toBe('en');
    expect(loadConfig({ ...base, CONUS_LANG: 'ru' }).lang).toBe('ru');
  });

  it('uses defaults and valid overrides', () => {
    const d = loadConfig(base);
    expect(d).toMatchObject({ port: 8080, host: '0.0.0.0', publicUrl: 'http://localhost:8080', cookieSecure: false, janitorIntervalMs: 300_000 });
    const c = loadConfig({ ...base, PORT: '9090', CONUS_JANITOR_INTERVAL_MS: '1000', HOST: '127.0.0.1' });
    expect(c).toMatchObject({ port: 9090, janitorIntervalMs: 1000, host: '127.0.0.1', publicUrl: 'http://localhost:9090' });
  });

  it('treats empty numeric/string env as unset (docker compose passes "")', () => {
    const c = loadConfig({ ...base, PORT: '', CONUS_JANITOR_INTERVAL_MS: '', HOST: '', PUBLIC_URL: '', CONUS_UI_DIR: '' });
    expect(c).toMatchObject({ port: 8080, janitorIntervalMs: 300_000, host: '0.0.0.0', publicUrl: 'http://localhost:8080' });
    expect(loadConfig({ ...base, PORT: '   ', CONUS_JANITOR_INTERVAL_MS: '  ' })).toMatchObject({ port: 8080, janitorIntervalMs: 300_000 });
  });

  it('falls back to defaults (with a warning) for non-numeric, non-positive, fractional or out-of-range numbers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const bad of ['abc', '0', '-5', '1.5', 'NaN', 'Infinity', '80x']) {
        expect(loadConfig({ ...base, PORT: bad }).port, `PORT=${bad}`).toBe(8080);
        expect(loadConfig({ ...base, CONUS_JANITOR_INTERVAL_MS: bad }).janitorIntervalMs, `JANITOR=${bad}`).toBe(300_000);
      }
      expect(loadConfig({ ...base, PORT: '70000' }).port).toBe(8080);
      // setInterval would turn anything above 2^31-1 into 1 ms
      expect(loadConfig({ ...base, CONUS_JANITOR_INTERVAL_MS: '99999999999' }).janitorIntervalMs).toBe(300_000);
      expect(warn).toHaveBeenCalled();
      // the default PUBLIC_URL follows the effective port
      expect(loadConfig({ ...base, PORT: 'abc' }).publicUrl).toBe('http://localhost:8080');
    } finally {
      warn.mockRestore();
    }
  });
});
