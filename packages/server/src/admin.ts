import { createAgent, createDb, getTaskById, managerSettleReview, migrate, REVIEW_VERDICTS, setOwnerPassword, type Db, type ReviewVerdict } from '@conus/core';
import { createInterface } from 'node:readline/promises';

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a;
}

async function stdinText(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

/**
 * Applies verdicts on tasks that wait in review, one JSON object per line:
 * {"id": "<task id>", "ref": "WB-12", "verdict": "accept" | "ask" | "recheck", "note": "…"}.
 * For sorting a long review queue outside the web app (see managerSettleReview for what each verdict does).
 * The whole file is checked first; one bad line and nothing is applied.
 */
async function settleReviews(db: Db, text: string, dryRun: boolean): Promise<void> {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const plan: { id: string; ref: string; verdict: ReviewVerdict; note: string }[] = [];
  for (const [i, line] of lines.entries()) {
    let v: { id?: unknown; ref?: unknown; verdict?: unknown; note?: unknown };
    try { v = JSON.parse(line); } catch { throw new Error(`line ${i + 1}: not JSON`); }
    if (typeof v.id !== 'string' || typeof v.ref !== 'string' || typeof v.note !== 'string' || !v.note.trim()
      || !(REVIEW_VERDICTS as readonly unknown[]).includes(v.verdict)) {
      throw new Error(`line ${i + 1}: expected {"id", "ref", "verdict": ${REVIEW_VERDICTS.join(' | ')}, "note"}`);
    }
    const task = await getTaskById(db, v.id);
    if (!task || task.deletedAt) throw new Error(`line ${i + 1}: task ${v.ref} not found`);
    if (task.ref !== v.ref) throw new Error(`line ${i + 1}: id belongs to ${task.ref}, not ${v.ref}`);
    plan.push({ id: v.id, ref: v.ref, verdict: v.verdict as ReviewVerdict, note: v.note });
  }
  const count: Record<string, number> = {};
  for (const p of plan) {
    const task = (await getTaskById(db, p.id))!;
    const res = task.status !== 'review' ? null
      : dryRun ? task : await managerSettleReview({ db, actor: { kind: 'manager' } }, { taskId: p.id, verdict: p.verdict, note: p.note });
    const what = res ? p.verdict : `skipped (${task.status})`;
    count[what] = (count[what] ?? 0) + 1;
    console.log(`${p.ref}\t${what}`);
  }
  console.log(`${dryRun ? 'would apply' : 'applied'}: ${Object.entries(count).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing'}`);
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
  } else if (cmd === 'settle-reviews') {
    await settleReviews(db, await stdinText(), args.includes('--dry-run'));
  } else {
    console.log('usage: admin <init|reset-password|create-agent <name> <kind>|settle-reviews [--dry-run] < verdicts.jsonl>');
    process.exitCode = 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
