import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { runCli } from './cli';
import { serveMcp } from './mcp-main';
import { installStdoutGuard } from './stdout-guard';
import type { Terminal } from './logo';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const argv = process.argv.slice(2);
if (argv[0] === 'mcp') {
  // A stdio MCP server: it lives until the agent closes stdin, and nothing but JSON-RPC may reach stdout.
  await serveMcp();
  process.exit(0);
}
const isHook = argv[0] === 'hook';
// Before the first write: a closed pipe must not turn a hook into a stack trace and a non-zero exit.
installStdoutGuard(isHook);

// Animations only where a person watches: a terminal, not CI, not NO_COLOR, never for hooks or the MCP bridge.
const interactive = process.stdout.isTTY && !process.env.CI && !process.env.NO_COLOR && process.env.TERM !== 'dumb' && !isHook;
const terminal: Terminal | undefined = interactive ? {
  columns: process.stdout.columns ?? 80,
  write: (s) => { process.stdout.write(s); },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  onInterrupt: (restore) => {
    const handler = () => { restore(); process.exit(130); };
    process.once('SIGINT', handler);
    return () => { process.off('SIGINT', handler); };
  },
} : undefined;
// The classic Windows console's fonts lack some glyphs; Windows Terminal and VS Code have them.
const plainGlyphs = process.platform === 'win32' && !process.env.WT_SESSION && process.env.TERM_PROGRAM !== 'vscode';

let code: number;
try {
  code = await runCli(argv, {
    stdout: (s) => process.stdout.write(s + (s.endsWith('\n') ? '' : '\n')),
    stderr: (s) => process.stderr.write(s + '\n'),
    readStdin,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    fetchImpl: fetch,
    run: (cmd, args) => {
      // Agent CLIs on Windows are .cmd shims, which only a shell starts; the arguments here are plain words.
      const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, timeout: 120_000 });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
    },
    terminal,
    plainGlyphs,
    ask: async (question) => {
      if (!process.stdin.isTTY) return null;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question(question); } finally { rl.close(); }
    },
  });
} catch {
  // runCli reports its own failures; reaching this point is unexpected, and a hook still must not fail.
  code = isHook ? 0 : 1;
}
// A stream error during the run may already have set exitCode (non-hook commands: 1); a hook never exits non-zero.
process.exitCode = isHook ? 0 : Math.max(code, Number(process.exitCode) || 0);
