export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`Conus server responded ${status}`);
  }
}

export interface Api {
  post<T = unknown>(path: string, body: unknown, timeoutMs: number): Promise<T | null>;
  get<T = unknown>(path: string, timeoutMs: number): Promise<T>;
}

export function createApi(cfg: { url: string; token: string }, fetchImpl: typeof fetch = fetch): Api {
  const base = cfg.url.replace(/\/+$/, '');
  async function call(method: string, path: string, body: unknown, timeoutMs: number) {
    const res = await fetchImpl(base + path, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  }
  return {
    post: (path, body, timeoutMs) => call('POST', path, body, timeoutMs) as Promise<any>,
    get: (path, timeoutMs) => call('GET', path, undefined, timeoutMs) as Promise<any>,
  };
}
