import { describe, expect, it } from 'vitest';
import { runProcess } from '../src/proc';

describe('runProcess', () => {
  it('passes stdin through and captures UTF-8 output', async () => {
    const r = await runProcess('node', ['-e', "process.stdin.pipe(process.stdout)"], { cwd: process.cwd(), env: process.env, input: 'Привет, мир' });
    expect(r).toMatchObject({ stdout: 'Привет, мир', killed: false, code: 0 });
  });

  it('after a kill it resolves even when a grandchild still holds the output pipes', async () => {
    // A middle process starts a pipe-holder (inherits stdout/stderr, lives 8 s) and exits at once, so the holder is
    // orphaned (and detached, so libuv's kill-on-close job on win32 spares it): no tree kill reaches it, and 'close'
    // would only fire when it ends by itself.
    const holder = "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:'inherit',detached:true}).unref()";
    const script = `require('child_process').spawn(process.execPath,['-e',\`${holder}\`],{stdio:'inherit'});setTimeout(()=>{},60000)`;
    const t0 = Date.now();
    const r = await runProcess('node', ['-e', script], { cwd: process.cwd(), env: process.env, input: '', killAfterSeconds: 1 });
    expect(r.killed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it('a normal exit resolves after a short grace even when a grandchild holds the pipes, and is not marked killed', async () => {
    const holder = "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:'inherit',detached:true}).unref()";
    const t0 = Date.now();
    const r = await runProcess('node', ['-e', holder], { cwd: process.cwd(), env: process.env, input: '', killAfterSeconds: 30 });
    expect(r).toMatchObject({ killed: false, code: 0 });
    expect(Date.now() - t0).toBeLessThan(6000);
  });
});
