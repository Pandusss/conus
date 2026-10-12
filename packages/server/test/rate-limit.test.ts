import { describe, expect, it } from 'vitest';
import { clientKey, RateLimiter } from '../src/rate-limit';

describe('RateLimiter', () => {
  it('allows `limit` hits per window, then blocks until the window slides', () => {
    const l = new RateLimiter(3, 1000);
    expect([l.hit('a', 0), l.hit('a', 1), l.hit('a', 2), l.hit('a', 3)]).toEqual([true, true, true, false]);
    expect(l.hit('b', 3)).toBe(true);
    expect(l.hit('a', 1000)).toBe(true); // the hit at t=0 left the window
  });

  it('a flood on one key keeps the stored array capped at the limit', () => {
    const l = new RateLimiter(10, 60_000);
    for (let i = 0; i < 100; i++) l.hit('flood', i);
    expect(l.stored('flood')).toBeLessThanOrEqual(10);
  });

  it('prunes keys whose hits all expired', () => {
    const l = new RateLimiter(10, 60_000);
    for (let i = 0; i < 50; i++) l.hit(`ip-${i}`, 0);
    expect(l.size).toBe(50);
    l.hit('late', 60_000);
    expect(l.size).toBe(1);
    expect(l.stored('ip-0')).toBe(0);
  });

  it('prunes on every hit once the key count exceeds maxKeys', () => {
    const l = new RateLimiter(10, 60_000, 5);
    for (let i = 0; i < 6; i++) l.hit(`old-${i}`, 0);
    for (let i = 0; i < 3; i++) l.hit(`new-${i}`, 30_000);
    expect(l.size).toBe(9);
    l.hit('newest', 60_001); // old-* expired; new-* still live
    expect(l.size).toBe(4);
  });
});

describe('clientKey', () => {
  it('uses the rightmost x-forwarded-for entry (the one the proxy appended)', () => {
    expect(clientKey('6.6.6.6, 1.2.3.4')).toBe('1.2.3.4');
    expect(clientKey(' 1.2.3.4 ')).toBe('1.2.3.4');
  });

  it('falls back to "local" for a missing or unparsable header', () => {
    expect(clientKey(undefined)).toBe('local');
    expect(clientKey('')).toBe('local');
    expect(clientKey('1.2.3.4, garbage')).toBe('local');
  });

  it('keys IPv6 addresses by their /64 prefix', () => {
    const a = clientKey('2001:db8:aa:bb:1:2:3:4');
    expect(a).toBe(clientKey('2001:0db8:00aa:00bb::ffff'));
    expect(a).toBe(clientKey('2001:DB8:AA:BB::1%eth0'));
    expect(clientKey('2001:db8:aa:bc::1')).not.toBe(a);
    expect(clientKey('2001:db8::1')).toBe(clientKey('2001:db8:0:0:ffff::'));
    expect(clientKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
  });

  it('two IPv6 addresses in the same /64 share one limit', () => {
    const l = new RateLimiter(2, 60_000);
    expect(l.hit(clientKey('2001:db8:1:2::10'), 0)).toBe(true);
    expect(l.hit(clientKey('2001:db8:1:2::20'), 1)).toBe(true);
    expect(l.hit(clientKey('2001:db8:1:2:aaaa::1'), 2)).toBe(false);
    expect(l.hit(clientKey('2001:db8:1:3::10'), 3)).toBe(true);
  });
});
