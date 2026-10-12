import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCodex, codexStatus, codexConfigBlock, CODEX_MARK_START } from '../src/install/codex';
import { assertBlockSane, upsertBlock } from '../src/install/agents-md';
import { claudePluginInstalled } from '../src/install/claude';
import { globalRuleTargets, installRules } from '../src/install/rules';
import { hookTotalBudgetMs } from '../src/hook/run';
import { AGENTS_MD_BLOCK, AGENTS_MD_END, AGENTS_MD_START, GLOBAL_RULES_BLOCK, SKILL_MD } from '@conus/protocol';

const tmp = () => mkdtempSync(join(tmpdir(), 'conus-inst-'));

describe('installCodex', () => {
  it('writes MCP block, hooks and skill; is idempotent; preserves user config and hooks', () => {
    const home = tmp(); const skills = tmp();
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.5-codex"\n\n[mcp_servers.other]\nurl = "https://x/mcp"\n');
    writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }] } }));
    installCodex({ codexHome: home, skillsDir: skills, platform: 'linux' });
    installCodex({ codexHome: home, skillsDir: skills, platform: 'linux' });
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(toml).toContain('model = "gpt-5.5-codex"');
    expect(toml).toContain('[mcp_servers.other]');
    expect(toml.split(CODEX_MARK_START)).toHaveLength(2);
    expect(toml).toContain('[mcp_servers.conus]\ncommand = "conus"\nargs = ["mcp"]\nrequired = false\n');
    const hooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8')).hooks;
    expect(hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command))).toEqual(['notify-me', 'conus hook stop --agent codex']);
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(hooks.SessionEnd[0].hooks[0].timeout).toBeLessThanOrEqual(3);
    expect(readFileSync(join(skills, 'task-protocol', 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect(codexStatus(home, skills)).toEqual({ config: true, hooks: true, trustedHint: false, skill: true });
  });
  it('every conus hook also carries commandWindows (spec §10.2) with the same conus invocation; a reinstall keeps one of each', () => {
    const home = tmp(); const skills = tmp();
    // an install from before commandWindows existed
    writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'conus hook stop --agent codex', timeout: 8 }] }] } }));
    installCodex({ codexHome: home, skillsDir: skills, platform: 'linux' });
    installCodex({ codexHome: home, skillsDir: skills, platform: 'linux' });
    const hooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8')).hooks;
    for (const [event, hook] of [['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'], ['PostToolUse', 'tool'], ['Stop', 'stop'], ['SessionEnd', 'session-end']]) {
      const entries = hooks[event!].flatMap((g: any) => g.hooks);
      expect(entries, event).toHaveLength(1);
      expect(entries[0], event).toMatchObject({ command: `conus hook ${hook} --agent codex`, commandWindows: `conus hook ${hook} --agent codex` });
    }
  });
  it('every Codex hook timeout covers the whole budget of the hook plus a second for process start', () => {
    const home = tmp();
    installCodex({ codexHome: home, skillsDir: tmp(), platform: 'linux' });
    const hooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8')).hooks;
    const events = { SessionStart: 'session-start', UserPromptSubmit: 'prompt', PostToolUse: 'tool', Stop: 'stop', SessionEnd: 'session-end' } as const;
    for (const [event, hook] of Object.entries(events)) expect(hooks[event][0].hooks[0].timeout * 1000, event).toBeGreaterThanOrEqual(hookTotalBudgetMs(hook) + 1000);
  });
  it('refuses to clobber a hand-written [mcp_servers.conus]', () => {
    const home = tmp();
    writeFileSync(join(home, 'config.toml'), '[mcp_servers.conus]\nurl = "mine"\n');
    expect(() => installCodex({ codexHome: home, skillsDir: tmp(), platform: 'linux' })).toThrow(/mcp_servers\.conus/);
  });
  it('refuses an unusable hooks.json before writing anything', () => {
    for (const bad of ['{ nope', 'null', '[]']) {
      const home = tmp(); const skills = tmp();
      writeFileSync(join(home, 'hooks.json'), bad);
      expect(() => installCodex({ codexHome: home, skillsDir: skills, platform: 'linux' })).toThrow(/hooks\.json/);
      expect(existsSync(join(home, 'config.toml'))).toBe(false);
      expect(existsSync(join(skills, 'task-protocol'))).toBe(false);
      expect(readFileSync(join(home, 'hooks.json'), 'utf8')).toBe(bad);
    }
  });
  it.each([
    ['quoted basic key', '[mcp_servers."conus"]\nurl = "mine"\n'],
    ['quoted literal key', "[mcp_servers.'conus']\nurl = \"mine\"\n"],
    ['bare sub-table', '[mcp_servers.conus.env]\nA = "1"\n'],
    ['quoted sub-table with spaces', '[ mcp_servers . "conus" . http_headers ]\nA = "1"\n'],
    ['quoted mcp_servers key', '["mcp_servers".conus]\nurl = "mine"\n'],
    ['top-level dotted key', 'mcp_servers.conus.url = "mine"\n'],
    ['top-level dotted key with quoted conus', 'mcp_servers."conus".url = "mine"\n'],
    ['top-level dotted table value', 'mcp_servers.conus = { url = "mine" }\n'],
    ['key under [mcp_servers]', '[mcp_servers]\nconus = { url = "mine" }\n'],
    ['dotted key under [mcp_servers]', '[mcp_servers]\n"conus".url = "mine"\n'],
    ['inline mcp_servers table', 'mcp_servers = { other = { url = "x" }, conus = { url = "mine" } }\n'],
  ])('refuses a hand-written conus server written as: %s', (_name, config) => {
    const home = tmp(); const skills = tmp();
    writeFileSync(join(home, 'config.toml'), config);
    expect(() => installCodex({ codexHome: home, skillsDir: skills, platform: 'linux' })).toThrow(/mcp_servers\.conus/);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config);
    expect(existsSync(join(home, 'hooks.json'))).toBe(false);
    expect(existsSync(join(skills, 'task-protocol'))).toBe(false);
  });
  it.each([
    ['similarly named server', '[mcp_servers.tmx]\nurl = "x"\n'],
    ['commented out', '# [mcp_servers.conus]\n# mcp_servers.conus.url = "x"\n'],
    ['conus key in another mcp server table', '[mcp_servers.other]\nconus = 1\n'],
    ['conus key in the mcp_servers sibling', '[mcp_servers]\ntmx = 1\n'],
    ['dotted key inside an unrelated table', '[profile]\nmcp_servers.conus.url = "x"\n'],
    ['plain conus key at top level', 'conus = 1\n'],
  ])('does not mistake a neighbour for the conus server: %s', (_name, config) => {
    const home = tmp();
    writeFileSync(join(home, 'config.toml'), config);
    expect(() => installCodex({ codexHome: home, skillsDir: tmp(), platform: 'linux' })).not.toThrow();
    expect(readFileSync(join(home, 'config.toml'), 'utf8').startsWith(config.trimEnd())).toBe(true);
  });
  it.each([
    ['start without end plus notes', `model = "x"\n${CODEX_MARK_START}\n# my notes\n[mcp_servers.other]\nurl = "https://x/mcp"\n`],
    ['stray end marker', `model = "x"\n# <<< conus <<<\n[mcp_servers.other]\nurl = "https://x/mcp"\n`],
  ])('refuses unbalanced conus markers and writes nothing: %s', (_name, config) => {
    const home = tmp(); const skills = tmp();
    writeFileSync(join(home, 'config.toml'), config);
    expect(() => installCodex({ codexHome: home, skillsDir: skills, platform: 'linux' })).toThrow(/unbalanced/);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config);
    expect(existsSync(join(home, 'hooks.json'))).toBe(false);
    expect(existsSync(join(skills, 'task-protocol'))).toBe(false);
  });
  it('points Codex at the local `conus mcp` bridge; on Windows through cmd, which resolves the npm shim', () => {
    expect(codexConfigBlock('linux')).toBe(`${CODEX_MARK_START}\n[mcp_servers.conus]\ncommand = "conus"\nargs = ["mcp"]\nrequired = false\n# <<< conus <<<\n`);
    expect(codexConfigBlock('win32')).toContain('command = "cmd"\nargs = ["/c", "conus", "mcp"]');
  });
  it.skipIf(process.platform === 'win32')('writes through symlinked config, hooks and skill files, keeping them symlinks', () => {
    const home = tmp(); const skills = tmp(); const dotfiles = tmp();
    mkdirSync(join(skills, 'task-protocol'));
    const links: [link: string, real: string][] = [
      [join(home, 'config.toml'), join(dotfiles, 'config.toml')],
      [join(home, 'hooks.json'), join(dotfiles, 'hooks.json')],
      [join(skills, 'task-protocol', 'SKILL.md'), join(dotfiles, 'SKILL.md')],
    ];
    writeFileSync(links[0]![1], 'model = "x"\n');
    writeFileSync(links[1]![1], '{}\n');
    writeFileSync(links[2]![1], 'old skill\n');
    for (const [link, real] of links) symlinkSync(real, link);
    installCodex({ codexHome: home, skillsDir: skills, platform: 'linux' });
    for (const [link, real] of links) {
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, 'utf8')).toBe(readFileSync(link, 'utf8'));
    }
    expect(readFileSync(links[0]![1], 'utf8')).toContain(CODEX_MARK_START);
    expect(JSON.parse(readFileSync(links[1]![1], 'utf8')).hooks.Stop).toBeDefined();
    expect(readFileSync(links[2]![1], 'utf8')).toBe(SKILL_MD);
  });
});

describe('upsertBlock', () => {
  it('creates, updates in place and leaves surrounding text', () => {
    const d = tmp(); const f = join(d, 'AGENTS.md');
    expect(upsertBlock(f, AGENTS_MD_BLOCK, AGENTS_MD_START, AGENTS_MD_END, true)).toBe('created');
    writeFileSync(f, '# Project\n\n' + readFileSync(f, 'utf8') + '\nmore\n');
    expect(upsertBlock(f, AGENTS_MD_BLOCK, AGENTS_MD_START, AGENTS_MD_END, true)).toBe('unchanged');
    const changed = AGENTS_MD_BLOCK.replace('Task manager', 'Task manager v2');
    expect(upsertBlock(f, changed, AGENTS_MD_START, AGENTS_MD_END, true)).toBe('updated');
    const text = readFileSync(f, 'utf8');
    expect(text.startsWith('# Project')).toBe(true);
    expect(text).toContain('v2');
    expect(text.split(AGENTS_MD_START)).toHaveLength(2);
    expect(upsertBlock(join(d, 'CLAUDE.md'), AGENTS_MD_BLOCK, AGENTS_MD_START, AGENTS_MD_END, false)).toBe('skipped');
  });
  it('refuses a start marker without an end marker and leaves the file untouched', () => {
    const f = join(tmp(), 'AGENTS.md');
    const original = `# Project\n\n${AGENTS_MD_START}\nmy own notes\n\nmore notes\n`;
    writeFileSync(f, original);
    for (let run = 0; run < 2; run++) {
      expect(() => upsertBlock(f, AGENTS_MD_BLOCK, AGENTS_MD_START, AGENTS_MD_END, true)).toThrow(/start marker without an end marker/);
      expect(readFileSync(f, 'utf8')).toBe(original);
    }
  });
  it('assertBlockSane flags a start marker without an end marker and never writes', () => {
    const dir = tmp();
    const ok = (name: string, text: string | null) => {
      const f = join(dir, name);
      if (text !== null) writeFileSync(f, text);
      expect(() => assertBlockSane(f, AGENTS_MD_START, AGENTS_MD_END)).not.toThrow();
      expect(existsSync(f)).toBe(text !== null);
    };
    ok('missing.md', null);
    ok('plain.md', '# no block\n');
    ok('block.md', AGENTS_MD_BLOCK);
    ok('stray-end.md', `${AGENTS_MD_END}\ntext\n${AGENTS_MD_BLOCK}`);
    const broken = join(dir, 'broken.md');
    const original = `# P\n${AGENTS_MD_START}\nnotes\n`;
    writeFileSync(broken, original);
    expect(() => assertBlockSane(broken, AGENTS_MD_START, AGENTS_MD_END)).toThrow(/start marker without an end marker/);
    expect(readFileSync(broken, 'utf8')).toBe(original);
  });
  it('ignores a stray end marker before the block and stays idempotent', () => {
    const f = join(tmp(), 'AGENTS.md');
    writeFileSync(f, `# Project\n\nNever delete ${AGENTS_MD_END} by hand.\n\n${AGENTS_MD_BLOCK}\nmore\n`);
    expect(upsertBlock(f, AGENTS_MD_BLOCK, AGENTS_MD_START, AGENTS_MD_END, true)).toBe('unchanged');
    expect(upsertBlock(f, AGENTS_MD_BLOCK.replace('Task manager', 'Task manager v2'), AGENTS_MD_START, AGENTS_MD_END, true)).toBe('updated');
    const text = readFileSync(f, 'utf8');
    expect(text).toContain('Never delete');
    expect(text).toContain('v2');
    expect(text).toContain('\nmore\n');
    expect(text.split(AGENTS_MD_START)).toHaveLength(2);
  });
  it('treats a lone end marker as text: appends once, then is idempotent', () => {
    const f = join(tmp(), 'AGENTS.md');
    writeFileSync(f, `# Project\n\nNever delete ${AGENTS_MD_END} by hand.\n`);
    expect(upsertBlock(f, AGENTS_MD_BLOCK, AGENTS_MD_START, AGENTS_MD_END, true)).toBe('updated');
    const afterFirst = readFileSync(f, 'utf8');
    expect(upsertBlock(f, AGENTS_MD_BLOCK, AGENTS_MD_START, AGENTS_MD_END, true)).toBe('unchanged');
    expect(upsertBlock(f, AGENTS_MD_BLOCK, AGENTS_MD_START, AGENTS_MD_END, true)).toBe('unchanged');
    expect(readFileSync(f, 'utf8')).toBe(afterFirst);
    expect(afterFirst.split(AGENTS_MD_START)).toHaveLength(2);
    expect(afterFirst.startsWith('# Project\n\nNever delete')).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('writes through a symlinked AGENTS.md, keeping it a symlink', () => {
    const d = tmp(); const dotfiles = tmp();
    const real = join(dotfiles, 'AGENTS.md'); const link = join(d, 'AGENTS.md');
    writeFileSync(real, '# Mine\n');
    symlinkSync(real, link);
    expect(upsertBlock(link, AGENTS_MD_BLOCK, AGENTS_MD_START, AGENTS_MD_END, true)).toBe('updated');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('# Mine\n\n' + AGENTS_MD_BLOCK);
    expect(upsertBlock(link, AGENTS_MD_BLOCK.replace('Task manager', 'Task manager v2'), AGENTS_MD_START, AGENTS_MD_END, true)).toBe('updated');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toContain('v2');
  });
});

describe('installRules', () => {
  it('creates files only for agents present, keeps user text, and is idempotent', () => {
    const home = tmp();
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'AGENTS.md'), '# mine\n');
    const targets = globalRuleTargets(home, join(home, '.codex'));
    expect(installRules(targets).map((r) => r.result)).toEqual(['created', 'updated', 'skipped']);
    expect(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8')).toBe(`# mine\n\n${GLOBAL_RULES_BLOCK}`);
    expect(existsSync(join(home, '.gemini', 'GEMINI.md'))).toBe(false);
    expect(installRules(globalRuleTargets(home, join(home, '.codex'))).map((r) => r.result)).toEqual(['unchanged', 'unchanged', 'skipped']);
  });

  it('writes nothing when any target has a start marker without an end marker', () => {
    const home = tmp();
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'AGENTS.md'), `${AGENTS_MD_START}\nbroken\n`);
    expect(() => installRules(globalRuleTargets(home, join(home, '.codex')))).toThrow(/start marker without an end marker/);
    expect(existsSync(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
  });
});

describe('claudePluginInstalled', () => {
  it('detects conus@ in installed_plugins.json', () => {
    const d = tmp();
    expect(claudePluginInstalled(d)).toBe(false);
    mkdirSync(join(d, 'plugins'));
    writeFileSync(join(d, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'conus@conus': [{}] } }));
    expect(claudePluginInstalled(d)).toBe(true);
    expect(existsSync(join(d, 'plugins'))).toBe(true);
  });
});
