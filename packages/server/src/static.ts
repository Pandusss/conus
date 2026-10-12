import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, posix, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

export interface UiResponse {
  status: number;
  type: string;
  body: Buffer;
  /** True only when a real file under assets/ was served (content-hashed, safe to cache forever). */
  immutable: boolean;
}

export function serveUi(uiDir: string) {
  const root = resolve(uiDir);
  const assetsRoot = join(root, 'assets') + sep;
  return async (path: string): Promise<UiResponse | null> => {
    if (path.startsWith('/api/') || path === '/mcp' || path === '/healthz') return null;
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { return null; } // malformed %-escape: plain 404, never a 500
    const target = resolve(join(root, normalize(decoded)));
    if (target.startsWith(root + sep)) {
      const s = await stat(target).catch(() => null);
      if (s?.isFile()) {
        return {
          status: 200, type: TYPES[extname(target)] ?? 'application/octet-stream', body: await readFile(target),
          immutable: target.startsWith(assetsRoot),
        };
      }
    }
    // No such file. Only extension-less, non-asset paths are SPA routes; a missing asset or file must 404
    // (never a cacheable HTML page in place of a JS/CSS/image file).
    const raw = decoded.replaceAll('\\', '/');
    const clean = posix.normalize(raw);
    const underAssets = (p: string) => p === '/assets' || p.startsWith('/assets/');
    if (underAssets(raw) || underAssets(clean) || posix.extname(clean) !== '') return null;
    const index = await readFile(join(root, 'index.html')).catch(() => null);
    return index ? { status: 200, type: TYPES['.html']!, body: index, immutable: false } : null;
  };
}
