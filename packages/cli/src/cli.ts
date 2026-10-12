import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import pkg from '../package.json' with { type: 'json' };
import { join } from 'node:path';
import { AGENTS_MD_BLOCK, AGENTS_MD_END, AGENTS_MD_START } from '@conus/protocol';
import { createApi } from './api-client';
import { readConfig, updateConfig, writeConfig, type ConusConfig } from './config';
import { setRepoEnabled } from './disable';
import { runDoctor, type Check } from './doctor';
import { repoContext } from './git';
import { runHook } from './hook/run';
import type { AgentFlavor, HookEvent } from './hook/normalize';
import { assertBlockSane, upsertBlock } from './install/agents-md';
import { detectLang, translator, type Translate } from './i18n';
import { claudeCliAvailable, claudeInstallInstructions, DEFAULT_MARKETPLACE, installClaudePlugin, type Run } from './install/claude';
import { installCodex } from './install/codex';
import { installGemini } from './install/gemini';
import { globalRuleTargets, installRules } from './install/rules';

export const VERSION: string = pkg.version;
export interface CliIO {
  stdout(s: string): void; stderr(s: string): void; readStdin(): Promise<string>;
  env: NodeJS.ProcessEnv; cwd: string; platform: NodeJS.Platform; fetchImpl: typeof fetch;
  /** Runs a program and waits for it (through a shell on Windows, where agent CLIs are .cmd shims). */
  run: Run;
  /** Asks the user a question on the terminal; null when stdin is not a terminal. */
  ask(question: string): Promise<string | null>;
}

const help = (t: Translate) => `conus ${VERSION} — ${t('the agent client of the Conus task manager', 'агентский клиент менеджера задач Conus')}
  conus setup [<url> <token>]      ${t('log in and connect every agent on this machine (Claude Code, Codex, Gemini CLI)', 'войти и подключить всех агентов на машине (Claude Code, Codex, Gemini CLI)')}
  conus login <url> <token>        ${t('log in (token from the web app: Agents → Connect agent)', 'войти (токен в веб-интерфейсе: Агенты → Подключить агента)')}
  conus install claude|codex|gemini ${t('connect one agent', 'подключить одного агента')}
  conus install rules              ${t('the Conus rule in every agent\'s global instructions', 'правило Conus в глобальных инструкциях каждого агента')}
  conus doctor                     ${t('check the whole chain', 'проверить всю цепочку')}
  conus disable | conus enable     ${t('stop/resume tracking in the current repository', 'отключить/включить учёт в текущем репозитории')}
  conus init --agents-md           ${t('add the Conus block to the repository\'s AGENTS.md / CLAUDE.md', 'добавить блок Conus в AGENTS.md / CLAUDE.md репозитория')}
  conus config set send_text <true|false>
  conus mcp                        ${t('the MCP server agents start (stdio)', 'MCP-сервер, который запускают агенты (stdio)')}
  conus hook <event> --agent <claude|codex>   ${t('(called by agent hooks)', '(вызывается хуками агентов)')}`;

const EVENTS: HookEvent[] = ['session-start', 'prompt', 'tool', 'stop', 'session-end'];
const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const VALUE_FLAGS = new Set(['--marketplace', '--codex-home', '--agent']);
const positional = (argv: string[]) => argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1] ?? ''));

// Whitespace, quotes and control characters (C0, DEL, C1) never belong in a server URL or a token (base64url).
const UNSAFE_CHARS = /[\s"'`\u0000-\u001f\u007f-\u009f]/;

/** Returns an error message when `raw` is not an acceptable server URL, else null. */
function urlProblem(raw: string, t: Translate): string | null {
  const invalid = t('Invalid server URL: use an http:// or https:// address without spaces, quotes or control characters.',
    'Некорректный URL сервера: нужен адрес http:// или https:// без пробелов, кавычек и управляющих символов.');
  if (UNSAFE_CHARS.test(raw)) return invalid;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return invalid; }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? null : invalid;
}

/** Checks the token against the server and saves the login; returns the agent's name, or prints why not and returns null. */
async function login(url: string, token: string, io: CliIO, t: Translate): Promise<string | null> {
  const problem = urlProblem(url, t);
  if (problem) { io.stderr(problem); return null; }
  if (UNSAFE_CHARS.test(token)) { io.stderr(t('Invalid token: it must not contain spaces, quotes or control characters.', 'Некорректный токен: в нём не должно быть пробелов, кавычек и управляющих символов.')); return null; }
  const clean = url.replace(/\/+$/, '');
  try {
    const who = await createApi({ url: clean, token }, io.fetchImpl).get<{ agent?: { name?: unknown } }>('/api/hooks/whoami', 5000);
    const name = who?.agent?.name;
    if (typeof name !== 'string' || !name) throw new Error(t('unexpected server answer (is this a Conus server?)', 'неожиданный ответ сервера (это точно сервер Conus?)'));
    const prev = readConfig({ CONUS_CONFIG_DIR: io.env.CONUS_CONFIG_DIR });
    writeConfig({ url: clean, token, sendText: prev?.sendText ?? true }, io.env);
    return name;
  } catch (e) {
    io.stderr(`${t('Could not log in', 'Не удалось войти')}: ${messageOf(e)}`);
    return null;
  }
}

/** The agent the saved login belongs to, or null when there is no working login. */
async function currentAgent(cfg: ConusConfig | null, io: CliIO): Promise<string | null> {
  if (!cfg) return null;
  try {
    const who = await createApi(cfg, io.fetchImpl).get<{ agent?: { name?: unknown } }>('/api/hooks/whoami', 5000);
    return typeof who?.agent?.name === 'string' ? who.agent.name : null;
  } catch { return null; }
}

type BlockResult = 'created' | 'updated' | 'unchanged' | 'skipped';
const blockResult = (r: BlockResult, t: Translate) => ({
  created: t('created', 'создан'), updated: t('updated', 'обновлён'), unchanged: t('unchanged', 'без изменений'),
  skipped: t('skipped: the agent is not installed', 'пропущен: агент не установлен'),
})[r];

function printChecks(io: CliIO, checks: Check[]) {
  for (const c of checks) io.stdout(`${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'} ${c.name}: ${c.detail}`);
}

interface AgentHomes { home: string; codexHome: string; geminiHome: string }

function installClaude(io: CliIO, t: Translate, marketplace: string): string {
  if (!claudeCliAvailable(io.run)) return claudeInstallInstructions(marketplace, t);
  const failed = installClaudePlugin(io.run, marketplace);
  return failed === null
    ? t('Claude Code: conus plugin installed. Restart Claude Code.', 'Claude Code: плагин conus установлен. Перезапусти Claude Code.')
    : `${t('Claude Code: the claude CLI failed', 'Claude Code: команда claude не сработала')}: ${failed}\n${claudeInstallInstructions(marketplace, t)}`;
}

function installCodexFor(io: CliIO, t: Translate, h: AgentHomes): string {
  const r = installCodex({ codexHome: h.codexHome, skillsDir: join(h.home, '.agents', 'skills'), platform: io.platform });
  return `${t('Codex: written', 'Codex: записано')}:\n  ${r.changed.join('\n  ')}\n${t('Open Codex once and approve the hooks with /hooks.', 'Открой Codex и один раз одобри хуки командой /hooks.')}`;
}

function installGeminiFor(io: CliIO, t: Translate, h: AgentHomes): string {
  const r = installGemini({ geminiHome: h.geminiHome, platform: io.platform });
  return `${t('Gemini CLI: MCP server added to', 'Gemini CLI: MCP-сервер добавлен в')} ${r.changed[0]}`;
}

async function setup(rest: string[], io: CliIO, t: Translate, h: AgentHomes): Promise<number> {
  const [argUrl, argToken] = positional(rest);
  let agent: string | null = null;
  if (argUrl && argToken) {
    agent = await login(argUrl, argToken, io, t);
    if (!agent) return 1;
  } else {
    agent = await currentAgent(readConfig(io.env), io);
    if (!agent) {
      io.stdout(t('Connect this machine to your Conus server. The token is in the web app: Agents → Connect agent.',
        'Подключим машину к серверу Conus. Токен — в веб-интерфейсе: Агенты → Подключить агента.'));
      const url = (await io.ask(t('Server URL: ', 'Адрес сервера: ')))?.trim();
      const token = url ? (await io.ask(t('Agent token: ', 'Токен агента: ')))?.trim() : undefined;
      if (!url || !token) { io.stderr(t('usage: conus setup <url> <token>', 'использование: conus setup <url> <token>')); return 1; }
      agent = await login(url, token, io, t);
      if (!agent) return 1;
    }
  }
  io.stdout(t(`Logged in as ${agent}.`, `Вход выполнен: агент ${agent}.`));

  const marketplace = flag(rest, '--marketplace') ?? DEFAULT_MARKETPLACE;
  const found: string[] = [];
  const attempt = (name: string, step: () => string) => {
    found.push(name);
    try { io.stdout(step()); } catch (e) { io.stderr(`${name}: ${messageOf(e)}`); }
  };
  if (existsSync(join(h.home, '.claude')) || claudeCliAvailable(io.run)) attempt('Claude Code', () => installClaude(io, t, marketplace));
  if (existsSync(h.codexHome)) attempt('Codex', () => installCodexFor(io, t, h));
  if (existsSync(h.geminiHome)) attempt('Gemini CLI', () => installGeminiFor(io, t, h));
  if (!found.length) {
    io.stdout(t('No agents found (Claude Code, Codex, Gemini CLI). Install one and run conus setup again.',
      'Агенты не найдены (Claude Code, Codex, Gemini CLI). Установи хотя бы одного и запусти conus setup ещё раз.'));
  }

  let rules = !rest.includes('--no-rules');
  if (rules && !rest.includes('--yes')) {
    const answer = await io.ask(t('Add the Conus rule to your agents\' global instructions? [Y/n] ', 'Добавить правило Conus в глобальные инструкции агентов? [Y/n] '));
    if (answer !== null && /^\s*n/i.test(answer)) rules = false;
  }
  if (rules && found.length) {
    for (const r of installRules(globalRuleTargets(h.home, h.codexHome))) io.stdout(`${t('rule', 'правило')} ${r.agent}: ${blockResult(r.result, t)} (${r.file})`);
  }

  io.stdout('');
  const checks = await runDoctor(io, h.home, t);
  printChecks(io, checks);
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [cmd, ...rest] = argv;
  const home = io.env.CONUS_HOME_OVERRIDE || homedir();
  const t = translator(detectLang(io.env));
  const homes: AgentHomes = { home, codexHome: io.env.CODEX_HOME || join(home, '.codex'), geminiHome: join(home, '.gemini') };
  try {
    switch (cmd) {
      case 'hook': {
        const event = rest[0] as HookEvent;
        const agent = (flag(rest, '--agent') ?? 'claude') as AgentFlavor;
        if (!EVENTS.includes(event) || !['claude', 'codex'].includes(agent)) return 0;
        const out = await runHook(agent, event, await io.readStdin(), { env: io.env, fetchImpl: io.fetchImpl });
        if (out) io.stdout(out);
        return 0;
      }
      case 'setup': return await setup(rest, io, t, homes);
      case 'login': {
        const [url, token] = rest;
        if (!url || !token) { io.stderr(t('usage: conus login <url> <token>', 'использование: conus login <url> <token>')); return 1; }
        const agent = await login(url, token, io, t);
        if (!agent) return 1;
        io.stdout(t(`Logged in as ${agent}.`, `Вход выполнен: агент ${agent}.`));
        return 0;
      }
      case 'install': {
        const target = rest[0];
        const needsLogin = () => { if (readConfig(io.env)) return false; io.stderr(t('Log in first: conus setup', 'Сначала войди: conus setup')); return true; };
        if (target === 'claude') { io.stdout(installClaude(io, t, flag(rest, '--marketplace') ?? DEFAULT_MARKETPLACE)); return 0; }
        if (target === 'codex') {
          if (needsLogin()) return 1;
          io.stdout(installCodexFor(io, t, { ...homes, codexHome: flag(rest, '--codex-home') ?? homes.codexHome }));
          return 0;
        }
        if (target === 'gemini') {
          if (needsLogin()) return 1;
          io.stdout(installGeminiFor(io, t, homes));
          return 0;
        }
        if (target === 'rules') {
          const results = installRules(globalRuleTargets(home, flag(rest, '--codex-home') ?? homes.codexHome));
          io.stdout(results.map((r) => `${r.agent}: ${blockResult(r.result, t)} (${r.file})`).join('\n'));
          return 0;
        }
        io.stderr(t('usage: conus install claude|codex|gemini|rules', 'использование: conus install claude|codex|gemini|rules'));
        return 1;
      }
      case 'doctor': {
        const checks = await runDoctor(io, home, t);
        printChecks(io, checks);
        return checks.some((c) => c.status === 'fail') ? 1 : 0;
      }
      case 'disable':
      case 'enable': {
        const repo = repoContext(io.cwd);
        if (!repo) { io.stderr(t('Not a git repository.', 'Не git-репозиторий.')); return 1; }
        setRepoEnabled(repo.root, cmd === 'enable');
        io.stdout(cmd === 'enable'
          ? t(`Task tracking is on in ${repo.rootName}.`, `Учёт задач включён в ${repo.rootName}.`)
          : t(`Task tracking is off in ${repo.rootName}.`, `Учёт задач отключён в ${repo.rootName}.`));
        return 0;
      }
      case 'init': {
        if (!rest.includes('--agents-md')) { io.stderr(t('usage: conus init --agents-md', 'использование: conus init --agents-md')); return 1; }
        const repo = repoContext(io.cwd);
        if (!repo) { io.stderr(t('Not a git repository.', 'Не git-репозиторий.')); return 1; }
        const agentsFile = join(repo.root, 'AGENTS.md');
        const claudeFile = join(repo.root, 'CLAUDE.md');
        // Check both files before writing either: a refusal on CLAUDE.md must not leave AGENTS.md already changed.
        assertBlockSane(agentsFile, AGENTS_MD_START, AGENTS_MD_END);
        assertBlockSane(claudeFile, AGENTS_MD_START, AGENTS_MD_END);
        const a = upsertBlock(agentsFile, AGENTS_MD_BLOCK, AGENTS_MD_START, AGENTS_MD_END, true);
        const c = upsertBlock(claudeFile, AGENTS_MD_BLOCK, AGENTS_MD_START, AGENTS_MD_END, false);
        io.stdout(`AGENTS.md: ${blockResult(a, t)}; CLAUDE.md: ${blockResult(c, t)}`);
        return 0;
      }
      case 'config': {
        if (rest[0] === 'set' && rest[1] === 'send_text' && (rest[2] === 'true' || rest[2] === 'false')) {
          updateConfig({ sendText: rest[2] === 'true' }, io.env);
          io.stdout(`send_text = ${rest[2]}`);
          return 0;
        }
        io.stderr(t('usage: conus config set send_text <true|false>', 'использование: conus config set send_text <true|false>'));
        return 1;
      }
      case '--version': io.stdout(VERSION); return 0;
      case 'help': case '--help': case undefined: io.stdout(help(t)); return 0;
      default: io.stderr(help(t)); return 1;
    }
  } catch (e) {
    // Refusals of the installers (hand-written config, unbalanced markers) arrive here as plain messages.
    // The message itself can fail to print (closed stderr); that must not turn a hook into a crash.
    try { io.stderr(messageOf(e)); } catch { /* nothing left to report to */ }
    return cmd === 'hook' ? 0 : 1;
  }
}
