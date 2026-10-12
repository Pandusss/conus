import { isIP } from 'node:net';

/** Spec §11: per agent token, shared by /api/hooks/* and /mcp. */
export const AGENT_RATE_LIMIT = 600;
export const AGENT_RATE_WINDOW_MS = 60_000;
export const AGENT_RATE_LIMITED_MESSAGE = 'Too many requests for this agent token; retry in a minute.';

/**
 * Sliding-window limiter held in memory. Memory stays bounded: a key never stores more than `limit` timestamps
 * (blocked hits are not recorded), and keys whose hits all left the window are pruned once per window, or on every
 * hit while more than `maxKeys` keys are stored.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private lastPrune = 0;
  constructor(private limit: number, private windowMs: number, private maxKeys = 1000) {}

  /** true = allowed. */
  hit(key: string, now = Date.now()): boolean {
    if (this.hits.size > this.maxKeys || now - this.lastPrune >= this.windowMs) this.prune(now);
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  /** Number of keys currently stored. */
  get size(): number {
    return this.hits.size;
  }

  /** Number of timestamps stored for `key`. */
  stored(key: string): number {
    return this.hits.get(key)?.length ?? 0;
  }

  private prune(now: number): void {
    this.lastPrune = now;
    for (const [key, arr] of this.hits) {
      if (arr.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}

/** The per-agent limiter; keyed by agent id after authentication. */
export function agentRateLimiter(): RateLimiter {
  return new RateLimiter(AGENT_RATE_LIMIT, AGENT_RATE_WINDOW_MS);
}

/** First four hextets of an IPv6 address (the /64 a single client typically owns), normalized. */
function ipv6Prefix64(ip: string): string {
  const width = (parts: string[]) => parts.reduce((n, p) => n + (p.includes('.') ? 2 : 1), 0);
  const [headS, tailS] = ip.split('::') as [string, string | undefined];
  const head = headS ? headS.split(':') : [];
  let groups = head;
  if (tailS !== undefined) {
    const tail = tailS ? tailS.split(':') : [];
    groups = [...head, ...Array<string>(Math.max(0, 8 - width(head) - width(tail))).fill('0'), ...tail];
  }
  return groups.slice(0, 4).map((g) => (g.includes('.') ? '0' : parseInt(g, 16).toString(16))).join(':') + '::/64';
}

/**
 * Rate-limit key for a request behind the reverse proxy: the RIGHTMOST `x-forwarded-for` entry is the address the
 * proxy itself saw (entries to its left are client-supplied). IPv6 clients are keyed by their /64. Anything
 * missing or unparsable shares the `local` bucket, so garbage values cannot be rotated to dodge the limit.
 */
export function clientKey(xff: string | null | undefined): string {
  const raw = (xff ?? '').split(',').pop()?.trim() ?? '';
  const ip = raw.split('%')[0]!; // drop an IPv6 zone id
  const v = isIP(ip);
  if (v === 4) return ip;
  if (v === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    return mapped ? mapped[1]! : ipv6Prefix64(ip.toLowerCase());
  }
  return 'local';
}
