import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWriteTarget, writeFileAtomic } from '../fsutil';
import { existingMode } from './codex';

/** Gemini CLI starts stdio servers without a shell too: on Windows cmd resolves npm's `conus` shim. */
export function geminiServer(platform: NodeJS.Platform) {
  return platform === 'win32' ? { command: 'cmd', args: ['/c', 'conus', 'mcp'] } : { command: 'conus', args: ['mcp'] };
}

/** Adds the `conus` MCP server to ~/.gemini/settings.json, keeping everything else in the file. */
export function installGemini(opts: { geminiHome: string; platform: NodeJS.Platform }): { changed: string[] } {
  const file = join(opts.geminiHome, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON; fix it and run again.`); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object; fix it and run again.`);
    settings = parsed as Record<string, unknown>;
  }
  const servers = settings.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new Error(`${file}: "mcpServers" is not an object; fix it and run again.`);
  }
  settings.mcpServers = { ...(servers as Record<string, unknown> | undefined), conus: geminiServer(opts.platform) };
  mkdirSync(opts.geminiHome, { recursive: true });
  const target = resolveWriteTarget(file);
  writeFileAtomic(target, JSON.stringify(settings, null, 2) + '\n', existingMode(target));
  return { changed: [file] };
}

export function geminiInstalled(geminiHome: string): boolean {
  try { return !!JSON.parse(readFileSync(join(geminiHome, 'settings.json'), 'utf8'))?.mcpServers?.conus; } catch { return false; }
}
