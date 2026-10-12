import { describe, expect, it } from 'vitest';
import { invalidReason, type TurnOutcome } from '../src/outcome';

const turn = (p: Partial<TurnOutcome> = {}): TurnOutcome => ({
  session: 1, turn: 1, hasResult: true, isError: false, errorDetail: null, killed: false, plannedKill: false, mcpStatus: 'connected', ...p,
});

describe('invalidReason', () => {
  it('a clean run is valid', () => {
    expect(invalidReason([turn(), turn({ turn: 2 })], 1, 1)).toBeNull();
  });
  it('fewer server sessions than the scenario runs in parallel invalidates', () => {
    expect(invalidReason([turn()], 0, 1)).toMatch(/server recorded 0 hook session\(s\) for the project, expected 1/);
    const two = [turn(), turn({ session: 2 })];
    expect(invalidReason(two, 1, 2)).toMatch(/recorded 1 hook session\(s\) for the project, expected 2/);
    expect(invalidReason(two, 2, 2)).toBeNull();
    expect(invalidReason([turn()], 2, 1)).toBeNull(); // more (e.g. a resume counted separately) is fine
  });
  it('is_error invalidates and records the detail', () => {
    expect(invalidReason([turn({ isError: true, errorDetail: 'API Error: 529' })], 1, 1)).toMatch(/s1t1: is_error \(API Error: 529\)/);
  });
  it('a turn without a parseable final result invalidates', () => {
    expect(invalidReason([turn(), turn({ turn: 2, hasResult: false })], 1, 1)).toMatch(/s1t2: no parseable final result/);
  });
  it('a kill by the runner timeout invalidates; a planned kill does not', () => {
    expect(invalidReason([turn({ killed: true, hasResult: false })], 1, 1)).toMatch(/killed by the runner timeout/);
    expect(invalidReason([turn({ killed: true, plannedKill: true, hasResult: false })], 1, 1)).toBeNull();
  });
  it('the Conus MCP server must be connected in every turn where the runner can see it', () => {
    expect(invalidReason([turn({ mcpStatus: 'failed' })], 1, 1)).toMatch(/s1t1: conus MCP failed/);
    expect(invalidReason([turn({ mcpStatus: 'absent' })], 1, 1)).toMatch(/conus MCP absent/);
    expect(invalidReason([turn({ session: 2, mcpStatus: null })], 1, 1)).toMatch(/s2t1: conus MCP no init event/);
    expect(invalidReason([turn({ mcpStatus: undefined })], 1, 1)).toBeNull(); // runner cannot observe MCP (Codex)
  });
  it('no turns at all invalidates', () => {
    expect(invalidReason([], 1, 1)).toMatch(/no turns/);
  });
  it('joins several reasons', () => {
    expect(invalidReason([turn({ isError: true, mcpStatus: 'failed' })], 0, 1)!.split('; ')).toHaveLength(3);
  });
});
