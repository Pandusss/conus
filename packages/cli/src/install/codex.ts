import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_MD } from '@conus/protocol';
import { resolveWriteTarget, writeFileAtomic } from '../fsutil';

export const CODEX_MARK_START = '# >>> conus >>>';
export const CODEX_MARK_END = '# <<< conus <<<';

const EVENTS: [event: string, hook: string, timeout: number, async: boolean][] = [
  ['SessionStart', 'session-start', 5, false],
  ['UserPromptSubmit', 'prompt', 3, false],
  ['PostToolUse', 'tool', 5, true],
  ['Stop', 'stop', 8, false],
  ['SessionEnd', 'session-end', 3, false],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Permission bits of an existing file (POSIX only), so an atomic replace does not widen e.g. a 0600 config. */
export function existingMode(path: string): number | undefined {
  if (process.platform === 'win32') return undefined;
  try { return statSync(path).mode & 0o777; } catch { return undefined; }
}

/** A TOML basic string: `\`, `"` and control characters escaped, so a URL can never break out of its value. */
function tomlString(s: string): string {
  const escaped = s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
    switch (c) {
      case '\\': return '\\\\';
      case '"': return '\\"';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\b': return '\\b';
      case '\f': return '\\f';
      default: return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });
  return `"${escaped}"`;
}

// TOML lets a key be bare, "basic-quoted" or 'literal-quoted', with optional spaces around dots, so
// the conus server can be defined as [mcp_servers.conus], [mcp_servers."conus".env], mcp_servers.conus.url = ...,
// conus = { ... } under [mcp_servers], or mcp_servers = { conus = { ... } }.
const tomlKey = (name: string) => `(?:${name}|"${name}"|'${name}')`;
const MCP = tomlKey('mcp_servers');
const NAME = tomlKey('conus');
const DOT = String.raw`\s*\.\s*`;
const CONUS_TABLE = new RegExp(String.raw`^\s*\[\[?\s*${MCP}${DOT}${NAME}\s*[\].]`);
const CONUS_DOTTED_KEY = new RegExp(String.raw`^\s*${MCP}${DOT}${NAME}\s*[.=]`);
const MCP_INLINE_NAME = new RegExp(String.raw`^\s*${MCP}\s*=.*[{,]\s*${NAME}\s*[.=]`);
const MCP_TABLE = new RegExp(String.raw`^\s*\[\s*${MCP}\s*\]`);
const CONUS_KEY_IN_MCP = new RegExp(String.raw`^\s*${NAME}\s*[.=]`);
const ANY_TABLE = /^\s*\[\[?\s*[^[\],=#]+?\s*\]\]?\s*(?:#.*)?$/;

function definesConusServer(toml: string): boolean {
  let section: 'root' | 'mcp' | 'other' = 'root';
  for (const line of toml.split(/\r?\n/)) {
    if (CONUS_TABLE.test(line)) return true;
    if (ANY_TABLE.test(line)) { section = MCP_TABLE.test(line) ? 'mcp' : 'other'; continue; }
    if (section === 'root' && (CONUS_DOTTED_KEY.test(line) || MCP_INLINE_NAME.test(line))) return true;
    if (section === 'mcp' && CONUS_KEY_IN_MCP.test(line)) return true;
  }
  return false;
}

/** The MCP server entry: the local `conus mcp` bridge (stdio), which reads the server URL and token from the conus config. */
export function codexConfigBlock(platform: NodeJS.Platform): string {
  // Codex starts stdio servers without a shell, and npm's `conus` on Windows is a .cmd shim that only cmd resolves.
  const [command, args] = platform === 'win32' ? ['cmd', ['/c', 'conus', 'mcp']] : ['conus', ['mcp']];
  return `${CODEX_MARK_START}\n[mcp_servers.conus]\ncommand = ${tomlString(command)}\nargs = [${args.map(tomlString).join(', ')}]\nrequired = false\n${CODEX_MARK_END}\n`;
}

export function installCodex(opts: { codexHome: string; skillsDir: string; platform: NodeJS.Platform; cliCommand?: string }): { changed: string[] } {
  const conus = opts.cliCommand ?? 'conus';
  mkdirSync(opts.codexHome, { recursive: true });
  const configPath = join(opts.codexHome, 'config.toml');
  let toml = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const blockRe = new RegExp(`${escapeRe(CODEX_MARK_START)}[\\s\\S]*?${escapeRe(CODEX_MARK_END)}\\n?`, 'g');
  toml = toml.replace(blockRe, '');
  // A marker left over after removing the complete blocks is unbalanced; the next run could swallow user text between them.
  if (toml.includes(CODEX_MARK_START) || toml.includes(CODEX_MARK_END)) {
    throw new Error(`${configPath} has an unbalanced conus marker (${CODEX_MARK_START} / ${CODEX_MARK_END}); fix it manually and run again.`);
  }
  if (definesConusServer(toml)) {
    throw new Error(`${configPath} already defines [mcp_servers.conus] outside the conus markers; remove it and run again.`);
  }
  toml = toml.replace(/\s*$/, '');

  const hooksPath = join(opts.codexHome, 'hooks.json');
  let hooksFile: { hooks?: Record<string, any[]> } = {};
  if (existsSync(hooksPath)) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(hooksPath, 'utf8')); } catch { throw new Error(`${hooksPath} is not valid JSON; fix it and run again.`); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${hooksPath} is not a JSON object; fix it and run again.`);
    hooksFile = parsed as typeof hooksFile;
  }
  const hooks = hooksFile.hooks ?? {};
  const ours = (h: any) => [h.command, h.commandWindows].some((c) => String(c ?? '').startsWith(`${conus} hook `));
  for (const [event, hook, timeout, isAsync] of EVENTS) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event]! : [])
      .map((g: any) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !ours(h)) }))
      .filter((g: any) => g.hooks.length);
    // Spec §10.2: commandWindows too. The global npm install puts the same `conus` on PATH on Windows (a conus.cmd shim
    // that cmd resolves), so the invocation is the same string.
    const command = `${conus} hook ${hook} --agent codex`;
    kept.push({ hooks: [{ type: 'command', command, commandWindows: command, timeout, ...(isAsync ? { async: true } : {}) }] });
    hooks[event] = kept;
  }

  // All parsing/validation is done before the first write, so a refusal never leaves a half-installed state.
  // Writes go to the real file behind a symlink so dotfiles-managed configs stay symlinks.
  const configTarget = resolveWriteTarget(configPath);
  writeFileAtomic(configTarget, (toml ? toml + '\n\n' : '') + codexConfigBlock(opts.platform), existingMode(configTarget));
  const hooksTarget = resolveWriteTarget(hooksPath);
  writeFileAtomic(hooksTarget, JSON.stringify({ ...hooksFile, hooks }, null, 2) + '\n', existingMode(hooksTarget));

  const skillPath = join(opts.skillsDir, 'task-protocol', 'SKILL.md');
  mkdirSync(join(opts.skillsDir, 'task-protocol'), { recursive: true });
  writeFileAtomic(resolveWriteTarget(skillPath), SKILL_MD);
  return { changed: [configPath, hooksPath, skillPath] };
}

export function codexStatus(codexHome: string, skillsDir: string) {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  const toml = read(join(codexHome, 'config.toml'));
  return {
    config: toml.includes(CODEX_MARK_START),
    hooks: read(join(codexHome, 'hooks.json')).includes('hook stop --agent codex'),
    trustedHint: /trusted_hash/.test(toml),
    skill: existsSync(join(skillsDir, 'task-protocol', 'SKILL.md')),
  };
}
