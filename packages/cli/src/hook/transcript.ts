import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { clamp } from '../clamp';

export const EXCERPT_MAX = 2000;

/** The first `max` UTF-16 units; never ends in half a surrogate pair. */
export function headExcerpt(s: string | null, max = EXCERPT_MAX): string | null {
  if (!s) return null;
  return clamp(s, max);
}
/** The last `max` UTF-16 units, '…' included; never starts with half a surrogate pair. */
export function tailExcerpt(s: string | null, max = EXCERPT_MAX): string | null {
  if (!s) return null;
  if (s.length <= max) return s;
  let tail = s.slice(-(max - 1));
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  return '…' + tail;
}

function textOf(o: any): string | null {
  if (o?.type === 'assistant' && Array.isArray(o.message?.content)) {
    const t = o.message.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n').trim();
    return t || null;
  }
  if (o?.type === 'response_item' && o.payload?.role === 'assistant' && Array.isArray(o.payload.content)) {
    const t = o.payload.content.filter((b: any) => b?.type === 'output_text' && typeof b.text === 'string').map((b: any) => b.text).join('\n').trim();
    return t || null;
  }
  if (o?.type === 'event_msg' && o.payload?.type === 'agent_message' && typeof o.payload.message === 'string') return o.payload.message.trim() || null;
  return null;
}

/**
 * The JSON entries of the last `maxBytes` of a JSONL transcript, newest first. A partial first line and non-JSON
 * lines are skipped; a missing or unreadable file is null. Never throws.
 */
function entriesFromEnd(path: string, maxBytes: number): unknown[] | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    const out: unknown[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* partial first line or non-JSON */ }
    }
    return out;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Walks the last `maxBytes` of a JSONL transcript from the end and returns the first non-null `pick` result. */
function lastMatching<T>(path: string, maxBytes: number, pick: (o: any) => T | null): T | null {
  for (const o of entriesFromEnd(path, maxBytes) ?? []) {
    try {
      const t = pick(o);
      if (t !== null) return t;
    } catch { /* an entry of an unexpected shape */ }
  }
  return null;
}

const isToolResult = (o: any): boolean => Array.isArray(o?.message?.content) && o.message.content.some((b: any) => b?.type === 'tool_result');

/**
 * An entry that starts a turn in a Claude Code transcript: a main-thread `user` entry that is not a tool result and not
 * Claude Code's meta or compaction entries — a typed prompt (text, an image only, or both) or a background-task
 * notification (`promptSource: "system"`); each carries its own promptId. A Stop-hook feedback continuation does not:
 * as recorded it is `isMeta` and keeps the turn's promptId, and so do the tool results after it.
 */
function startsTurn(o: any): boolean {
  if (o?.type !== 'user' || o.isSidechain === true || o.isMeta === true || o.isCompactSummary === true) return false;
  const c = o.message?.content;
  return typeof c === 'string' || (Array.isArray(c) && !isToolResult(o));
}

/** One tool call of a turn, as the transcript records it. */
export interface TurnToolCall {
  name: string | null;
  command: string | null;
  /** The tool_use entry's time (ms), null when not recorded. */
  startedAt: number | null;
  /** The tool_result entry's time (ms), null when not recorded. */
  endedAt: number | null;
  /** The tool result's `toolUseResult` (Claude Code's structured result, e.g. with `gitOperation`). */
  result: unknown;
}

const timeOf = (o: any): number | null => {
  const t = typeof o?.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * The tool calls of the current turn of a Claude Code transcript, oldest first: each tool result paired with its
 * tool_use (tool name, command, both entries' times). A turn is delimited by its promptId (the turn's first entry and
 * every tool result of it carry it): the Stop payload's `prompt_id`, else the promptId of the newest entry that starts
 * a turn. Without promptIds the turn is everything after the newest entry that starts a turn. Only main-thread entries
 * count: a subagent's tool calls are in its own file (`<session>/subagents/*.jsonl`), so its commits reach conus through
 * PostToolUse only. Reads at most the last `maxBytes`. Null when the file cannot be read; Codex rollouts have no such
 * entries ([]).
 */
export function currentTurnToolCalls(path: string, promptId: string | null, maxBytes = 1024 * 1024): TurnToolCall[] | null {
  const entries = entriesFromEnd(path, maxBytes) as any[] | null;
  if (!entries) return null;
  const uses = new Map<string, { name: string | null; command: string | null; at: number | null }>();
  for (const o of entries) {
    if (o?.type !== 'assistant' || o.isSidechain === true || !Array.isArray(o.message?.content)) continue;
    for (const b of o.message.content) {
      if (b?.type !== 'tool_use' || typeof b.id !== 'string') continue;
      uses.set(b.id, { name: typeof b.name === 'string' ? b.name : null, command: typeof b.input?.command === 'string' ? b.input.command : null, at: timeOf(o) });
    }
  }
  const main = entries.filter((o) => o?.type === 'user' && o.isSidechain !== true);
  const turn = promptId ?? main.find((o) => startsTurn(o) && typeof o.promptId === 'string')?.promptId ?? null;
  const out: TurnToolCall[] = [];
  for (const o of main) {
    if (turn === null && startsTurn(o)) break;
    if (!isToolResult(o) || (turn !== null && o.promptId !== turn)) continue;
    const id = o.message.content.find((b: any) => b?.type === 'tool_result')?.tool_use_id;
    const use = typeof id === 'string' ? uses.get(id) : undefined;
    out.push({ name: use?.name ?? null, command: use?.command ?? null, startedAt: use?.at ?? null, endedAt: timeOf(o), result: o.toolUseResult ?? null });
  }
  return out.reverse();
}

/** Last assistant text in a Claude transcript or Codex rollout (JSONL), reading at most the last `maxBytes`. */
export function lastAssistantText(path: string, maxBytes = 256 * 1024): string | null {
  return lastMatching(path, maxBytes, textOf);
}

/** Server limit for a session model (StopBody in packages/server/src/routes/hooks.ts). */
const MODEL_MAX = 100;

/**
 * Model of the last main-thread assistant entry of a Claude Code transcript (`message.model`; subagent
 * `isSidechain` entries and Claude Code's `<synthetic>` messages are skipped). Claude Code's SessionStart
 * carries no model (recorded from 2.1.270), so this is how the session learns it.
 */
export function lastAssistantModel(path: string, maxBytes = 256 * 1024): string | null {
  return lastMatching(path, maxBytes, (o) => {
    if (o?.type !== 'assistant' || o.isSidechain === true) return null;
    const m = o.message?.model;
    if (typeof m !== 'string' || !m || m === '<synthetic>') return null;
    return m.length <= MODEL_MAX ? m : null;
  });
}
