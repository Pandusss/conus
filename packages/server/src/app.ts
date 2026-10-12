import type { Agent, Db, Judge } from '@conus/core';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { toErrorResponse } from './http-errors';
import { agentRateLimiter, type RateLimiter } from './rate-limit';
import { hooksRoutes } from './routes/hooks';
import { uiRoutes } from './routes/ui';
import { serveUi } from './static';

export interface AppDeps {
  db: Db; judge: Judge; uiDir?: string | null; cookieSecure?: boolean;
  /** Per-agent limiter shared with /mcp (startServer passes one instance to both); a fresh one when omitted. */
  agentLimiter?: RateLimiter;
  /** First run: the code that lets the browser set the owner password; null once an owner existed at start. */
  setupCode?: string | null;
}
export type AppEnv = { Variables: { agent: Agent } };

/** Same cap as the /mcp handler. Hook bodies stay far below it (200 facts of ≤ 500-char paths: well under 400 KB). */
export const API_BODY_LIMIT = 1_000_000;

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => {
    const { status, body } = toErrorResponse(err);
    return c.json(body, status as 400);
  });
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.use('/api/*', bodyLimit({
    maxSize: API_BODY_LIMIT,
    onError: (c) => c.json({ error: { code: 'payload_too_large', message: 'Request body too large (max 1 MB).' } }, 413),
  }));
  app.route('/api/hooks', hooksRoutes({ ...deps, agentLimiter: deps.agentLimiter ?? agentRateLimiter() }));
  app.route('/api/ui', uiRoutes(deps));
  if (deps.uiDir) {
    const ui = serveUi(deps.uiDir);
    app.get('*', async (c) => {
      const r = await ui(c.req.path);
      if (!r) return c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
      const body = new Uint8Array(r.body.buffer as ArrayBuffer, r.body.byteOffset, r.body.byteLength);
      return c.body(body, r.status as 200, {
        'Content-Type': r.type,
        'Cache-Control': r.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
    });
  }
  return app;
}
