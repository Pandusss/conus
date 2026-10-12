import { describe, expect, it } from 'vitest';
import { assemble, CONE_CELL, finalFrame, frameAt, logoLayout, rule30 } from '../src';

const text = (cells: ({ ch: string } | null)[][]) => cells.map((r) => r.map((c) => c?.ch ?? ' ').join('').trimEnd()).join('\n');

describe('the Conus mark', () => {
  it('is Rule 30 from one cell', () => {
    const g = rule30(4).map((r) => r.map((on) => (on ? '#' : '.')).join(''));
    expect(g).toEqual(['...#...', '..###..', '.##..#.', '##.####']);
  });

  it('lays out the cone with the seed at the bottom and the wordmark to its right', () => {
    const l = logoLayout();
    const cone = l.glyphs.filter((g) => g.kind === 'cone');
    expect(cone.every((g) => g.ch === CONE_CELL)).toBe(true);
    expect(cone.filter((g) => g.y === l.height - 2)).toHaveLength(1); // the seed
    expect(text(finalFrame(l))).toContain('▄▀▀▀ ▄▀▀▄ █▀▀▄ █  █ ▄▀▀▀');
    expect(logoLayout({ wordmark: false }).glyphs.every((g) => g.kind === 'cone')).toBe(true);
    expect(logoLayout({ textWidth: 40 }).width).toBeGreaterThan(l.width);
  });

  it('starts as dust and ends as the finished picture; the same seed gives the same animation', () => {
    const l = logoLayout();
    const scene = assemble(l, 30);
    const start = frameAt(scene, 0).flat().filter(Boolean);
    expect(start.length).toBeGreaterThan(0);
    expect(start.some((c) => c!.ch === CONE_CELL || '▀▄█'.includes(c!.ch))).toBe(false);
    const end = frameAt(scene, scene.duration + 2000);
    expect(text(end)).toBe(text(finalFrame(l)));
    expect(JSON.stringify(assemble(l, 30))).toBe(JSON.stringify(scene));
    expect(JSON.stringify(assemble(l, 31))).not.toBe(JSON.stringify(scene));
    expect(assemble(l, 30, 2).duration).toBeCloseTo(scene.duration / 2);
  });
});
