import { spawn, spawnSync } from 'node:child_process';

const win = process.platform === 'win32';

/** How long to wait for 'close' once the process has exited: an orphaned grandchild (e.g. a stray hook) may hold the pipes. */
const EXIT_GRACE_MS = 2_000;
/** After a kill: give up waiting even if 'exit' never arrives (e.g. the kill itself failed). */
const KILL_GIVE_UP_MS = 10_000;

/**
 * On win32 the CLI runs through cmd.exe (so npm `.cmd` shims resolve too), which gets one command line:
 * quote anything beyond a safe charset. Prompts never go through here — they are piped via stdin,
 * which also keeps Cyrillic and `%`/`!` intact.
 */
const quote = (a: string) => (/[^\w\-.:/\\=@]/.test(a) ? `"${a}"` : a);

export interface ProcResult { stdout: string; stderr: string; killed: boolean; code: number | null }

/** Runs an agent CLI to completion, piping `input` to stdin; after `killAfterSeconds` the whole process tree is killed. */
export function runProcess(
  cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input: string; killAfterSeconds?: number },
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const spawnOpts = { cwd: opts.cwd, env: opts.env, stdio: 'pipe' as const };
    const child = win ? spawn([cmd, ...args.map(quote)].join(' '), { ...spawnOpts, shell: true }) : spawn(cmd, args, spawnOpts);
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      // Stop reading pipes a leftover grandchild may still hold, so they do not keep the eval process alive.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ stdout, stderr, killed, code });
    };
    child.stdout.setEncoding('utf8'); // decode across chunk boundaries (Cyrillic is multi-byte)
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    child.stdin.on('error', () => {}); // the CLI may exit before reading all of stdin
    child.stdin.end(opts.input);
    const killTimer = setTimeout(() => {
      killed = true;
      // On win32 the child is cmd.exe; killing it alone would leave the agent running and the pipes open.
      if (win && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
      timers.push(setTimeout(() => done(null), KILL_GIVE_UP_MS));
    }, (opts.killAfterSeconds ?? 900) * 1000);
    timers.push(killTimer);
    child.on('exit', (code) => {
      clearTimeout(killTimer); // a process that exited by itself is never marked killed
      timers.push(setTimeout(() => done(code), EXIT_GRACE_MS));
    });
    // A failed spawn (e.g. CLI not installed) may never emit 'close'.
    child.on('error', (e) => { stderr += `\n[spawn error] ${e.message}`; done(null); });
    child.on('close', done);
  });
}

/** First line of `<cmd> --version`, or 'unknown' (no model call). */
export function cliVersion(cmd: string): string {
  const opts = { encoding: 'utf8' as const, timeout: 30_000 };
  const r = win ? spawnSync(`${cmd} --version`, { ...opts, shell: true }) : spawnSync(cmd, ['--version'], opts);
  return (r.stdout ?? '').trim().split(/\r?\n/)[0] || 'unknown';
}
