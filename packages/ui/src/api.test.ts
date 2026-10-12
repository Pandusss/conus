import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, csrfToken, HttpError } from './api';

afterEach(() => vi.restoreAllMocks());

describe('api', () => {
  it('reads the csrf cookie', () => {
    expect(csrfToken('a=1; conus_csrf=XYZ; b=2')).toBe('XYZ');
    expect(csrfToken('a=1')).toBeNull();
  });
  it('sends csrf header on mutations and parses errors', async () => {
    document.cookie = 'conus_csrf=TOKEN';
    const f = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"error":{"code":"conflict_version","message":"changed"}}', { status: 409 }));
    await api('/agents', { method: 'POST', json: { name: 'x' } });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/ui/agents');
    expect((init as RequestInit).headers).toMatchObject({ 'x-csrf-token': 'TOKEN', 'content-type': 'application/json' });
    await expect(api('/tasks/1', { method: 'PATCH', json: {} })).rejects.toMatchObject({ status: 409, code: 'conflict_version' });
    expect(HttpError).toBeTypeOf('function');
  });
  it('turns a non-JSON error body (proxy 502 page) into an HttpError, not a SyntaxError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const err = await api('/tasks').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 502, code: 'error', message: 'Bad Gateway' });
  });
  it('turns a 200 response that is not JSON (SPA html behind a misrouted proxy) into an HttpError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<!doctype html><html></html>', { status: 200, statusText: 'OK' }));
    const err = await api('/tasks').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 200, code: 'error' });
  });
  it('returns null for an empty body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(api('/x')).resolves.toBeNull();
  });
});
