import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createTestDb } from '../../../test/helpers/db';
import { createAgent, recordFacts, resolveOrCreateProject, startSession, type Db } from './test-imports';
import { MCP_INSTRUCTIONS } from '@conus/protocol';
import { createMcpHandler, type McpHandler } from '../src/mcp';
import { RateLimiter } from '../src/rate-limit';

// Pass-through wrapper so a single test can make the post-mutation bookkeeping fail.
vi.mock('@conus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@conus/core')>();
  return { ...actual, recordFacts: vi.fn(actual.recordFacts) };
});

let db: Db; let drop: () => Promise<void>;
let server: http.Server; let base: string;
let mcp: ReturnType<typeof createMcpHandler>;
beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  mcp = createMcpHandler({ db });
  server = http.createServer((req, res) => void mcp.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await mcp.close();
  await new Promise((r) => server.close(r));
  await drop();
});

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const repo = { remote: 'git@github.com:me/mcp.git', rootName: 'mcp', rootPathHash: 'm1', branch: 'main' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rpcHeaders = (token: string, sid?: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  ...(sid ? { 'Mcp-Session-Id': sid } : {}),
});
async function rawInit(url: string, token: string): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: rpcHeaders(token),
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    }),
  });
  await res.text();
  expect(res.status).toBe(200);
  return res.headers.get('mcp-session-id')!;
}
async function rawPing(url: string, token: string, sid: string): Promise<number> {
  const res = await fetch(url, { method: 'POST', headers: rpcHeaders(token, sid), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) });
  await res.text();
  return res.status;
}
async function serve(h: McpHandler) {
  const srv = http.createServer((req, res) => void h.handle(req, res));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`,
    stop: async () => { await h.close(); await new Promise((r) => srv.close(r)); },
  };
}

describe('MCP endpoint', () => {
  it('rejects bad tokens', async () => {
    await expect(connect('tm_nope')).rejects.toThrow();
  });

  it('lists 8 tools and exposes instructions', async () => {
    const { token } = await createAgent(db, { name: 'a-list', kind: 'claude_code' });
    const c = await connect(token);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'task_block', 'task_complete', 'task_create', 'task_drop', 'task_propose', 'task_start', 'task_update', 'tasks_context',
    ]);
    expect(c.getInstructions()).toBe(MCP_INSTRUCTIONS);
    // Live run (Task 21): the agent passed blocked_by "user" for a missing webhook URL and the call failed.
    const block: any = tools.find((t) => t.name === 'task_block');
    expect(block.inputSchema.properties.blocked_by.description).toMatch(/task.*WB-12.*Omit.*credentials/is);
    await c.close();
  });

  it('binds calls to the single active session and records task_op activity', async () => {
    const { agent, token } = await createAgent(db, { name: 'a-bound', kind: 'claude_code' });
    const { session, project } = await startSession(db, { agentId: agent.id, agentSessionId: 'x1', source: 'startup', cwd: '/w', repo });
    const c = await connect(token);
    const r: any = await c.callTool({ name: 'task_create', arguments: { title: 'Добавить импорт CSV', start_now: true } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.outcome).toBe('created');
    expect(r.structuredContent.task.ref).toBe(`${project.key}-1`);
    expect(r.structuredContent.chat_note).toBe(`+${project.key}-1 Добавить импорт CSV → in progress`);
    const { rows } = await db.query(`SELECT session_id FROM task_events WHERE type = 'created'`);
    expect(rows[0].session_id).toBe(session.id);
    const act = await db.query(`SELECT data FROM session_activity WHERE session_id = $1 AND kind = 'task_op'`, [session.id]);
    expect(act.rows[0].data).toEqual({ tool: 'task_create', task: `${project.key}-1` });

    const dup: any = await c.callTool({ name: 'task_create', arguments: { title: 'Импорт CSV файлов' } });
    expect(dup.structuredContent.outcome).toBe('possible_duplicates');
    expect(dup.content[0].text).toContain('confirm_new');

    const ctx: any = await c.callTool({ name: 'tasks_context', arguments: { query: 'импорт' } });
    expect(ctx.structuredContent.tasks.map((t: any) => t.ref)).toEqual([`${project.key}-1`]);
    expect(ctx.structuredContent.session).toBe(session.ref);
    expect(ctx.structuredContent.session_tasks.map((t: any) => t.ref)).toEqual([`${project.key}-1`]);

    const done: any = await c.callTool({ name: 'task_complete', arguments: { task: `${project.key}-1`, result: 'Парсер и тесты готовы' } });
    expect(done.structuredContent.task.status).toBe('done');
    const after: any = await c.callTool({ name: 'tasks_context', arguments: { query: 'импорт', status: ['done'] } });
    expect(after.structuredContent.tasks.map((t: any) => t.status)).toEqual(['done']);
    await c.close();
  });

  it('without a session requires project; marks the agent as unbound', async () => {
    const { agent, token } = await createAgent(db, { name: 'a-nohooks', kind: 'other' });
    const c = await connect(token);
    const r: any = await c.callTool({ name: 'task_create', arguments: { title: 'Something' } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe('validation');
    const ok: any = await c.callTool({ name: 'task_create', arguments: { title: 'Brand new thing', project: 'https://github.com/me/mcp' } });
    expect(ok.structuredContent.outcome).toBe('created');
    const { rows } = await db.query('SELECT last_unbound_mcp_at FROM agents WHERE id = $1', [agent.id]);
    expect(rows[0].last_unbound_mcp_at).not.toBeNull();
    await c.close();
  });

  it('an unknown git remote creates its project (no hooks ran); unknown keys and non-remotes still fail', async () => {
    const { token } = await createAgent(db, { name: 'a-newrepo', kind: 'claude_code' });
    const c = await connect(token);
    const made: any = await c.callTool({ name: 'task_create', arguments: { title: 'Лента: лайки', project: 'https://github.com/acme/altegramAndroidX.git' } });
    expect(made.structuredContent.outcome).toBe('created');
    const { rows } = await db.query(`SELECT key, name FROM projects WHERE 'github.com/acme/altegramandroidx' = ANY(repo_fingerprints)`);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('altegramAndroidX');
    expect(made.structuredContent.task.ref).toBe(`${rows[0].key}-1`);
    // the same repo written as an scp-style remote resolves to the same project
    const ctx: any = await c.callTool({ name: 'tasks_context', arguments: { project: 'git@github.com:acme/altegramAndroidX.git' } });
    expect(ctx.structuredContent.tasks.map((t: any) => t.ref)).toEqual([`${rows[0].key}-1`]);
    for (const project of ['ZZZQ', 'not a remote', 'github.com']) {
      const r: any = await c.callTool({ name: 'tasks_context', arguments: { project } });
      expect(r.isError, project).toBe(true);
      expect(r.structuredContent.error.code, project).toBe('validation');
    }
    await c.close();
  });

  it('without session and project asks for the S-… session ref first, project as the alternative', async () => {
    const { token } = await createAgent(db, { name: 'a-noref', kind: 'other' });
    const c = await connect(token);
    const r: any = await c.callTool({ name: 'tasks_context', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe('validation');
    const text: string = r.content[0].text;
    expect(text).toMatch(/pass session \(the S-… ref/);
    expect(text).toMatch(/project/);
    expect(text.indexOf('session')).toBeLessThan(text.indexOf('project'));
    await c.close();
  });

  it('a call naming another project never binds to the agent\'s single session of a different project (rule 3)', async () => {
    const { agent, token } = await createAgent(db, { name: 'a-proj', kind: 'claude_code' });
    const { session, project } = await startSession(db, {
      agentId: agent.id, agentSessionId: 'pj-1', source: 'startup', cwd: '/a',
      repo: { remote: 'git@github.com:me/proj-a.git', rootName: 'proja', rootPathHash: 'pa', branch: 'main' },
    });
    const other = await resolveOrCreateProject(db, { remote: 'git@github.com:me/proj-b.git', rootName: 'projb', rootPathHash: 'pb' });
    const c = await connect(token);
    const r: any = await c.callTool({ name: 'task_create', arguments: { title: 'Работа в другом проекте', project: other.project.key } });
    expect(r.structuredContent.outcome).toBe('created');
    const ev = await db.query(
      `SELECT e.session_id FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = $1 AND e.type = 'created'`, [other.project.id],
    );
    expect(ev.rows).toEqual([{ session_id: null }]);
    expect((await db.query('SELECT mcp_session_ids FROM sessions WHERE id = $1', [session.id])).rows[0].mcp_session_ids).toEqual([]);
    // the session's own project binds as before
    const own: any = await c.callTool({ name: 'tasks_context', arguments: { project: project.key } });
    expect(own.structuredContent.session).toBe(session.ref);
    await c.close();
  });

  it('tool schemas ask for the S-… session ref from the block or status line, project only as a fallback', async () => {
    const { token } = await createAgent(db, { name: 'a-schema', kind: 'claude_code' });
    const c = await connect(token);
    const { tools } = await c.listTools();
    for (const t of tools as any[]) {
      expect(t.inputSchema.properties.session.description).toMatch(/S-….*<task-manager>.*status line/s);
      expect(t.inputSchema.properties.project.description).toMatch(/only when you have no session ref/);
    }
    await c.close();
  });

  it('maps domain errors', async () => {
    const { agent, token } = await createAgent(db, { name: 'a-err', kind: 'codex' });
    await startSession(db, { agentId: agent.id, agentSessionId: 'x9', source: 'startup', cwd: '/w', repo });
    const c = await connect(token);
    const r: any = await c.callTool({ name: 'task_start', arguments: { task: 'MCP-999' } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^not_found:/);
    await c.close();
  });

  it('returns a committed mutation as success when session bookkeeping fails', async () => {
    const { agent, token } = await createAgent(db, { name: 'a-facts', kind: 'claude_code' });
    const { project } = await startSession(db, {
      agentId: agent.id, agentSessionId: 'x5', source: 'startup', cwd: '/f',
      repo: { remote: 'git@github.com:me/facts.git', rootName: 'facts', rootPathHash: 'f1', branch: 'main' },
    });
    const c = await connect(token);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(recordFacts).mockRejectedValueOnce(new Error('activity insert failed'));
    const r: any = await c.callTool({ name: 'task_create', arguments: { title: 'Настроить CI пайплайн' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.outcome).toBe('created');
    expect(r.structuredContent.chat_note.startsWith(`+${project.key}-1 Настроить CI пайплайн`)).toBe(true);
    expect(r.content[0].text).toContain('chat_note:');
    expect(err).toHaveBeenCalledWith('[mcp] post-mutation bookkeeping failed', expect.any(Error));
    err.mockRestore();

    const p: any = await c.callTool({ name: 'task_propose', arguments: { title: 'Добавить тёмную тему', source_quote: 'хорошо бы тёмную тему' } });
    expect(p.structuredContent.outcome).toBe('created');
    const ctx: any = await c.callTool({ name: 'tasks_context', arguments: {} });
    expect(ctx.structuredContent.proposals).toBe(1);
    expect(ctx.content[0].text).toContain('Proposals awaiting the user: 1');
    await c.close();
  });

  it('refuses a session id presented with another agent token', async () => {
    const a = await createAgent(db, { name: 'a-owner', kind: 'claude_code' });
    const b = await createAgent(db, { name: 'b-intruder', kind: 'claude_code' });
    const sid = await rawInit(`${base}/mcp`, a.token);
    expect(await rawPing(`${base}/mcp`, b.token, sid)).toBe(403);
    expect(await rawPing(`${base}/mcp`, a.token, sid)).toBe(200);
  });

  it('answers malformed and oversized bodies with JSON-RPC errors', async () => {
    const { token } = await createAgent(db, { name: 'a-body', kind: 'other' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: rpcHeaders(token), body: '{"jsonrpc":' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    const big = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: rpcHeaders(token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(1_100_000) } }),
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Payload too large' }, id: null });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('MCP per-agent rate limit (spec §11)', () => {
  it('over the limit answers 429 with a JSON-RPC error body; other agents are unaffected', async () => {
    const s = await serve(createMcpHandler({ db, agentLimiter: new RateLimiter(2, 60_000) }));
    try {
      const { token } = await createAgent(db, { name: 'a-rl-mcp', kind: 'other' });
      const { token: other } = await createAgent(db, { name: 'b-rl-mcp', kind: 'other' });
      const sid = await rawInit(s.url, token);
      expect(await rawPing(s.url, token, sid)).toBe(200);
      const res = await fetch(s.url, { method: 'POST', headers: rpcHeaders(token, sid), body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) });
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests for this agent token; retry in a minute.' }, id: null });
      // a bad token is 401 and does not spend a budget
      expect((await fetch(s.url, { method: 'POST', headers: rpcHeaders('tm_nope'), body: '{}' })).status).toBe(401);
      const o = await rawInit(s.url, other);
      expect(await rawPing(s.url, other, o)).toBe(200);
    } finally {
      await s.stop();
    }
  });
});

describe('MCP session eviction', () => {
  it('evicts sessions idle longer than idleTtlMs (on access and in the sweep on init)', async () => {
    const s = await serve(createMcpHandler({ db, idleTtlMs: 150 }));
    try {
      const { token } = await createAgent(db, { name: 'a-ttl', kind: 'other' });
      const a = await rawInit(s.url, token);
      const c = await rawInit(s.url, token);
      expect(await rawPing(s.url, token, a)).toBe(200);
      await sleep(300);
      expect(await rawPing(s.url, token, a)).toBe(404);
      const closeSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');
      const b = await rawInit(s.url, token); // the sweep on init closes the idle session c
      expect(closeSpy).toHaveBeenCalledTimes(1);
      closeSpy.mockRestore();
      expect(await rawPing(s.url, token, c)).toBe(404);
      expect(await rawPing(s.url, token, b)).toBe(200);
    } finally {
      await s.stop();
    }
  });

  it('evicts the least recently seen session when maxSessions is reached', async () => {
    const s = await serve(createMcpHandler({ db, maxSessions: 2 }));
    try {
      const { token } = await createAgent(db, { name: 'a-max', kind: 'other' });
      const a = await rawInit(s.url, token);
      await sleep(5);
      const b = await rawInit(s.url, token);
      await sleep(5);
      expect(await rawPing(s.url, token, a)).toBe(200); // a is now more recent than b
      await sleep(5);
      const c = await rawInit(s.url, token);
      expect(await rawPing(s.url, token, b)).toBe(404);
      expect(await rawPing(s.url, token, a)).toBe(200);
      expect(await rawPing(s.url, token, c)).toBe(200);
    } finally {
      await s.stop();
    }
  });
});
