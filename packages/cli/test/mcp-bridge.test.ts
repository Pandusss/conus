import { describe, expect, it } from 'vitest';
import { createBridge, parseMessages, runBridge } from '../src/mcp-bridge';

type Call = { method: string; headers: Record<string, string>; body: any };

/** A fake Conus MCP endpoint: SSE answers, session ids, and a switch that "restarts" the server. */
function fakeServer() {
  const calls: Call[] = [];
  let live = new Set<string>();
  let n = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, headers, body });
    if (init.method === 'DELETE') return new Response(null, { status: 200 });
    if (body.method === 'initialize') {
      const sid = `sid-${++n}`;
      live.add(sid);
      const result = { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'conus' } } };
      return new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': sid } });
    }
    if (!live.has(headers['mcp-session-id'])) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = { jsonrpc: '2.0', id: body.id, result: { tools: [], session: headers['mcp-session-id'] } };
    return new Response(`data: ${JSON.stringify(result)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, restart: () => { live = new Set(); } };
}

const cfg = { url: 'https://conus.example/', token: 'conus_T' };
const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent' } } };

function setup(server = fakeServer(), config: typeof cfg | null = cfg) {
  const sent: any[] = [];
  const logs: string[] = [];
  const bridge = createBridge(config, { send: (m) => sent.push(m), fetchImpl: server.fetchImpl, log: (m) => logs.push(m) });
  return { server, sent, logs, bridge };
}

describe('conus mcp bridge', () => {
  it('relays initialize and later calls with the token, the session id and the negotiated protocol version', async () => {
    const { server, sent, bridge } = setup();
    await bridge.handle(init);
    await bridge.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(sent.map((m) => m.id)).toEqual([0, 1]);
    expect(sent[1].result.session).toBe('sid-1');
    const last = server.calls.at(-1)!;
    expect(server.calls.every((c) => c.headers.authorization === 'Bearer conus_T')).toBe(true);
    expect(last.headers['mcp-session-id']).toBe('sid-1');
    expect(last.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('survives a server restart: replays the agent\'s initialize once, then retries the call', async () => {
    const { server, sent, bridge } = setup();
    await bridge.handle(init);
    server.restart();
    await Promise.all([
      bridge.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'tasks_context' } }),
      bridge.handle({ jsonrpc: '2.0', id: 8, method: 'tools/list' }),
    ]);
    expect(sent.filter((m) => m.id !== 0).map((m) => [m.id, m.result?.session]).sort()).toEqual([[7, 'sid-2'], [8, 'sid-2']]);
    const replays = server.calls.filter((c) => c.body?.method === 'initialize');
    expect(replays).toHaveLength(2);
    expect(replays[1]!.body.params).toEqual(init.params);
    expect(server.calls.some((c) => c.body?.method === 'notifications/initialized' && c.headers['mcp-session-id'] === 'sid-2')).toBe(true);
    // the replayed initialize is the bridge's own business: the agent sees only its answers
    expect(sent.filter((m) => m.id === 'conus-bridge-reinitialize')).toEqual([]);
  });

  it('answers requests with an error when the server is unreachable, and stays silent on notifications', async () => {
    const down = { fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch, calls: [], restart() {} };
    const { sent, logs, bridge } = setup(down as any);
    await bridge.handle(init);
    await bridge.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 0, error: { code: -32000, message: 'Conus server unreachable: ECONNREFUSED. Continue your work.' } }]);
    expect(logs.join('\n')).toContain('ECONNREFUSED');
  });

  it('passes the server\'s refusal on to the agent under the request id', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing or invalid agent token' }, id: null }),
      { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const { sent, bridge } = setup({ fetchImpl } as any);
    await bridge.handle(init);
    expect(sent[0]).toMatchObject({ id: 0, error: { message: 'Conus server answered 401: Missing or invalid agent token. Continue your work.' } });
  });

  it('tells the agent to run conus setup when this machine is not set up', async () => {
    const { sent, bridge } = setup(fakeServer(), null);
    await bridge.handle(init);
    expect(sent[0].error.message).toContain('run `conus setup`');
  });

  it('reads stdin lines until EOF, reports malformed lines and ends the server session', async () => {
    const { server, sent, bridge } = setup();
    async function* lines() {
      yield JSON.stringify(init);
      yield '';
      yield '{not json';
      yield JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
    }
    await runBridge(lines(), bridge, { send: (m) => sent.push(m) });
    expect(sent.find((m) => m.error?.code === -32700)).toBeTruthy();
    expect(sent.map((m) => m.id)).toContain(2);
    expect(server.calls.at(-1)).toMatchObject({ method: 'DELETE', headers: { 'mcp-session-id': 'sid-1' } });
  });

  it('parses JSON bodies, batches and multi-event SSE streams', () => {
    expect(parseMessages('application/json', '{"id":1}')).toEqual([{ id: 1 }]);
    expect(parseMessages('application/json', '[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(parseMessages('text/event-stream', 'event: message\r\ndata: {"id":1}\r\n\r\nid: 5\ndata: {"id":2}\n\n')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(parseMessages('text/event-stream', ': keep-alive\n\n')).toEqual([]);
    expect(parseMessages('', '')).toEqual([]);
  });
});
