import { createDb, hasOwner, migrate, runJanitor, type Db } from '@conus/core';
import { getRequestListener } from '@hono/node-server';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import type { ServerConfig } from './config';
import { createMcpHandler } from './mcp';
import { agentRateLimiter } from './rate-limit';
import { newSetupCode } from './setup-code';

export async function startServer(cfg: ServerConfig): Promise<{ url: string; db: Db; setupCode: string | null; close(): Promise<void> }> {
  const db = createDb(cfg.databaseUrl);
  await migrate(db);
  const setupCode = (await hasOwner(db)) ? null : (cfg.setupCode || newSetupCode());
  // One per-agent budget for hooks and MCP together (spec §11).
  const agentLimiter = agentRateLimiter();
  const app = createApp({ db, judge: cfg.judge, uiDir: cfg.uiDir, cookieSecure: cfg.cookieSecure, agentLimiter, setupCode });
  const mcp = createMcpHandler({ db, agentLimiter });
  const listener = getRequestListener(app.fetch);
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/mcp') { void mcp.handle(req, res); return; }
    void listener(req, res);
  });
  await new Promise<void>((r) => server.listen(cfg.port, cfg.host, r));
  const { port } = server.address() as AddressInfo;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await runJanitor({ db, judge: cfg.judge });
      if (r.staled || r.released.length) console.log(`[janitor] staled=${r.staled} released=${r.released.map((x) => `${x.ref}->${x.to}`).join(',')}`);
    } catch (e) {
      console.error('[janitor] failed', e);
    } finally {
      running = false;
    }
  }, cfg.janitorIntervalMs);
  timer.unref();
  return {
    url: `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${port}`,
    db,
    setupCode,
    async close() {
      clearInterval(timer);
      await mcp.close();
      const closed = new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await closed;
      await db.end();
    },
  };
}
