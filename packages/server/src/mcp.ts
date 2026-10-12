import { authenticateAgent, type Db } from '@conus/core';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken } from './auth';
import { buildMcpServer } from './mcp-tools';
import { AGENT_RATE_LIMITED_MESSAGE, agentRateLimiter, type RateLimiter } from './rate-limit';

export interface McpHandler { handle(req: IncomingMessage, res: ServerResponse): Promise<void>; close(): Promise<void> }

export const MCP_IDLE_TTL_MS = 6 * 60 * 60 * 1000;
export const MCP_MAX_SESSIONS = 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const BODY_LIMIT = 1_000_000;

class BodyError extends Error {
  constructor(public readonly status: 400 | 413, public readonly rpcCode: number, message: string) { super(message); }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, code: number, message: string) {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

/** Reads the whole body (so a 413 reaches the client instead of a reset), buffering at most `limit` bytes. */
async function readJson(req: IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= limit) chunks.push(chunk as Buffer);
  }
  if (size > limit) throw new BodyError(413, -32000, 'Payload too large');
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new BodyError(400, -32700, 'Parse error');
  }
}

interface Entry { transport: StreamableHTTPServerTransport; agentId: string; lastSeen: number }

export function createMcpHandler(deps: { db: Db; idleTtlMs?: number; maxSessions?: number; agentLimiter?: RateLimiter }): McpHandler {
  const idleTtlMs = deps.idleTtlMs ?? MCP_IDLE_TTL_MS;
  const limiter = deps.agentLimiter ?? agentRateLimiter();
  const maxSessions = deps.maxSessions ?? MCP_MAX_SESSIONS;
  const sessions = new Map<string, Entry>();

  function evict(id: string) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    entry.transport.close().catch(() => {});
  }

  function sweep(now = Date.now()) {
    for (const [id, e] of sessions) if (now - e.lastSeen > idleTtlMs) evict(id);
  }

  function makeRoom() {
    while (sessions.size >= maxSessions) {
      let oldest: string | null = null;
      let oldestSeen = Infinity;
      for (const [id, e] of sessions) if (e.lastSeen < oldestSeen) { oldest = id; oldestSeen = e.lastSeen; }
      if (oldest === null) break;
      evict(oldest);
    }
  }

  const timer = setInterval(() => sweep(), SWEEP_EVERY_MS);
  timer.unref();

  return {
    async handle(req, res) {
      try {
        const token = bearerToken(req.headers.authorization);
        const agent = token ? await authenticateAgent(deps.db, token) : null;
        if (!agent) return rpcError(res, 401, -32001, 'Missing or invalid agent token');
        // Spec §11: per agent token (budget shared with /api/hooks/*). The unread body is discarded.
        if (!limiter.hit(agent.id)) {
          req.resume();
          return rpcError(res, 429, -32000, AGENT_RATE_LIMITED_MESSAGE);
        }
        const sid = req.headers['mcp-session-id'] as string | undefined;
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        if (sid) {
          const found = sessions.get(sid);
          // An entry idle past the TTL is gone even if the periodic sweep has not run yet.
          const entry = found && Date.now() - found.lastSeen <= idleTtlMs ? found : undefined;
          if (found && !entry) evict(sid);
          if (!entry) return rpcError(res, 404, -32001, 'Session not found');
          if (entry.agentId !== agent.id) return rpcError(res, 403, -32001, 'Session belongs to another agent');
          entry.lastSeen = Date.now();
          res.once('close', () => { entry.lastSeen = Date.now(); });
          await entry.transport.handleRequest(req, res, body);
          return;
        }
        if (req.method === 'POST' && isInitializeRequest(body)) {
          sweep();
          makeRoom();
          const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => { sessions.set(id, { transport, agentId: agent.id, lastSeen: Date.now() }); },
          });
          transport.onclose = () => {
            const id = transport.sessionId;
            if (id && sessions.get(id)?.transport === transport) sessions.delete(id);
          };
          const server = buildMcpServer({ db: deps.db, agent, mcpSessionId: () => transport.sessionId });
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }
        rpcError(res, 400, -32000, 'Bad Request: no valid session ID');
      } catch (e) {
        if (e instanceof BodyError) {
          if (!res.headersSent) rpcError(res, e.status, e.rpcCode, e.message);
          return;
        }
        console.error('[mcp] request failed', e);
        if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error');
      }
    },
    async close() {
      clearInterval(timer);
      const entries = [...sessions.values()];
      sessions.clear();
      for (const { transport } of entries) await transport.close().catch(() => {});
    },
  };
}
