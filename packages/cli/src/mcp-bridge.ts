/**
 * `conus mcp`: a stdio MCP server that relays every JSON-RPC message to the Conus server's streamable HTTP
 * endpoint. Agents start it like any local MCP server, so they need neither the server URL nor the token in
 * their environment: both come from ~/.conus/config.json (or CONUS_URL / CONUS_TOKEN).
 *
 * The server keeps MCP sessions in memory, so a restart forgets them and answers 404. The bridge then replays
 * the agent's own initialize once and retries the message: the agent never sees the restart.
 */

type Message = Record<string, unknown> & { id?: unknown; method?: unknown };

export interface BridgeIO {
  /** One JSON-RPC message for the agent; the caller writes it as one line. */
  send(message: Message): void;
  fetchImpl: typeof fetch;
  log(msg: string): void;
}

const REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 2_000;
const REPLAY_ID = 'conus-bridge-reinitialize';

const isRequest = (m: Message) => typeof m.method === 'string' && m.id !== undefined && m.id !== null;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function rpcError(id: unknown, message: string, code = -32000): Message {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Messages of a streamable HTTP response: a JSON body (one message or a batch) or an SSE stream of `data:` events. */
export function parseMessages(contentType: string, text: string): Message[] {
  if (!text.trim()) return [];
  if (contentType.includes('text/event-stream')) {
    const out: Message[] = [];
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) out.push(...([] as Message[]).concat(JSON.parse(data)));
    }
    return out;
  }
  return ([] as Message[]).concat(JSON.parse(text));
}

export function createBridge(cfg: { url: string; token: string } | null, io: BridgeIO) {
  const endpoint = cfg ? cfg.url.replace(/\/+$/, '') + '/mcp' : '';
  let initialize: Message | null = null;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let replaying: Promise<void> | null = null;

  async function post(message: Message): Promise<{ status: number; messages: Message[] }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg!.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (protocolVersion) headers['Mcp-Protocol-Version'] = protocolVersion;
    const res = await io.fetchImpl(endpoint, {
      method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    let messages: Message[];
    try { messages = parseMessages(res.headers.get('content-type') ?? '', text); } catch { messages = []; }
    return { status: res.status, messages };
  }

  function remember(messages: Message[]) {
    for (const m of messages) {
      const v = (m.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      if (typeof v === 'string') protocolVersion = v;
    }
  }

  /** Opens a fresh server session with the agent's own initialize; concurrent callers share one replay. */
  function replay(): Promise<void> {
    replaying ??= (async () => {
      sessionId = null;
      const r = await post({ ...initialize!, id: REPLAY_ID });
      if (r.status >= 400 || !sessionId) throw new Error(`re-initialize failed (${r.status})`);
      remember(r.messages);
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      io.log('mcp: server session re-initialized');
    })().finally(() => { replaying = null; });
    return replaying;
  }

  async function handle(message: Message): Promise<void> {
    if (!cfg) {
      if (isRequest(message)) io.send(rpcError(message.id, 'Conus is not set up on this machine: run `conus setup`. Continue your work.'));
      return;
    }
    try {
      if (message.method === 'initialize') {
        initialize = message;
        sessionId = null;
        protocolVersion = null;
      } else if (replaying) {
        await replaying.catch(() => {});
      }
      let r = await post(message);
      if (r.status === 404 && initialize && message.method !== 'initialize') {
        await replay();
        r = await post(message);
      }
      if (message.method === 'initialize') remember(r.messages);
      if (r.status >= 400) {
        if (!isRequest(message)) return;
        const answer = r.messages.find((m) => m.error);
        const text = (answer?.error as { message?: unknown } | undefined)?.message;
        io.send(rpcError(message.id, `Conus server answered ${r.status}${typeof text === 'string' ? `: ${text}` : ''}. Continue your work.`));
        return;
      }
      for (const m of r.messages) io.send(m);
    } catch (e) {
      io.log(`mcp: ${String(message.method ?? 'response')} failed: ${messageOf(e)}`);
      if (isRequest(message)) io.send(rpcError(message.id, `Conus server unreachable: ${messageOf(e)}. Continue your work.`));
    }
  }

  /** Ends the server session (best effort): the agent closed stdin. */
  async function close(): Promise<void> {
    if (!cfg || !sessionId) return;
    try {
      await io.fetchImpl(endpoint, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Mcp-Session-Id': sessionId },
        signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
      });
    } catch { /* the server forgets idle sessions on its own */ }
  }

  return { handle, close };
}

/** Feeds stdin lines to the bridge until the agent closes stdin; malformed lines get a parse error like any MCP server. */
export async function runBridge(lines: AsyncIterable<string>, bridge: ReturnType<typeof createBridge>, io: Pick<BridgeIO, 'send'>): Promise<void> {
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { io.send(rpcError(null, 'Parse error', -32700)); continue; }
    for (const m of ([] as Message[]).concat(parsed as Message)) {
      const p = bridge.handle(m).finally(() => pending.delete(p));
      pending.add(p);
    }
  }
  await Promise.allSettled([...pending]);
  await bridge.close();
}
