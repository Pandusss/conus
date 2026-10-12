import { authenticateAgent, type Db } from '@conus/core';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './app';

export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1]! : null;
}

export function agentAuth(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header('authorization'));
    const agent = token ? await authenticateAgent(db, token) : null;
    if (!agent) return c.json({ error: { code: 'unauthorized', message: 'Missing or invalid agent token.' } }, 401);
    c.set('agent', agent);
    await next();
  };
}
