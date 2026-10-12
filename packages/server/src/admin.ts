import { createAgent, createDb, migrate, setOwnerPassword } from '@conus/core';
import { createInterface } from 'node:readline/promises';

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a;
}

const [cmd, ...args] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
const db = createDb(url, 2);
await migrate(db);
try {
  if (cmd === 'init' || cmd === 'reset-password') {
    const pw = process.env.CONUS_OWNER_PASSWORD ?? (await ask('Owner password (min 8 chars): '));
    await setOwnerPassword(db, pw);
    console.log('Owner password set.');
  } else if (cmd === 'create-agent') {
    const [name, kind] = args;
    if (!name || !['claude_code', 'codex', 'other'].includes(kind ?? '')) throw new Error('usage: create-agent <name> <claude_code|codex|other>');
    const { token } = await createAgent(db, { name, kind: kind as 'claude_code' });
    console.log(token);
  } else {
    console.log('usage: admin <init|reset-password|create-agent <name> <kind>>');
    process.exitCode = 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
