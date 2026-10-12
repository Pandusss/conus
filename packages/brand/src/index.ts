/**
 * The Conus mark and its assembly animation, shared by the web app, the CLI and the README's SVG.
 *
 * The mark is the elementary cellular automaton Rule 30 grown from a single cell: the cone snail Conus textile
 * paints its shell with the same kind of local rule. In the animation, dust scattered over a character grid flies
 * along arcs to the cells of the cone and the letters of the wordmark and settles there. The model works in
 * character cells; each renderer only decides how a cell looks.
 */

export const CONE_ROWS = 11;
export const CONE_CELL = '▮';

/** Rule 30 grown from one live cell: `rows` generations, each 2·rows−1 cells wide. */
export function rule30(rows: number): boolean[][] {
  const n = 2 * rows - 1;
  let row = Array.from({ length: n }, (_, i) => i === rows - 1);
  const out: boolean[][] = [];
  for (let r = 0; r < rows; r++) {
    out.push(row);
    const prev = row;
    row = prev.map((_, i) => (i > 0 && prev[i - 1]!) !== (prev[i]! || (i < n - 1 && prev[i + 1]!)));
  }
  return out;
}

/** The wordmark in half blocks: four columns per letter, three lines. */
export const WORDMARK_FONT: Record<string, readonly [string, string, string]> = {
  c: ['▄▀▀▀', '█   ', '▀▄▄▄'],
  o: ['▄▀▀▄', '█  █', '▀▄▄▀'],
  n: ['█▀▀▄', '█  █', '█  █'],
  u: ['█  █', '█  █', '▀▄▄▀'],
  s: ['▄▀▀▀', '▀▀▀▄', '▄▄▄▀'],
};

export interface Glyph { x: number; y: number; ch: string; kind: 'cone' | 'word' }

export interface Layout {
  width: number; height: number; glyphs: Glyph[];
  /** Where a renderer may put a line of text under the wordmark (the tagline), or null without a wordmark. */
  textAt: { x: number; y: number } | null;
}

/**
 * The finished picture on a character grid: the cone (widest row on top, the seed at the bottom, mirrored like the
 * icon) and, unless `wordmark` is false, "conus" to its right. `textWidth` reserves room for a tagline.
 */
export function logoLayout(opts: { wordmark?: boolean; textWidth?: number; pad?: number } = {}): Layout {
  const pad = opts.pad ?? 2;
  const rows = CONE_ROWS;
  const n = 2 * rows - 1;
  const grid = rule30(rows);
  const glyphs: Glyph[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < n; c++) if (grid[r]![n - 1 - c]) glyphs.push({ x: pad + c, y: 1 + (rows - 1 - r), ch: CONE_CELL, kind: 'cone' });
  }
  const height = rows + 2;
  if (opts.wordmark === false) return { width: pad * 2 + n, height, glyphs, textAt: null };
  const wx = pad + n + 5;
  const wy = 4;
  [...'conus'].forEach((letter, i) => {
    WORDMARK_FONT[letter]!.forEach((line, dy) => {
      [...line].forEach((ch, dx) => { if (ch !== ' ') glyphs.push({ x: wx + i * 5 + dx, y: wy + dy, ch, kind: 'word' }); });
    });
  });
  const wordWidth = 5 * 5 - 1;
  return { width: wx + Math.max(wordWidth, opts.textWidth ?? 0) + pad, height, glyphs, textAt: { x: wx, y: wy + 4 } };
}

/** mulberry32: the same seed gives the same dust everywhere (tests, the README's SVG). */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DUST = '·.:˙∙,\'`';

/** A glyph of the picture, and the speck of dust that flies to it. Times are in milliseconds. */
export interface Particle extends Glyph { sx: number; sy: number; bend: number; delay: number; dur: number; speck: string }
/** A speck that only twinkles and fades away. */
export interface Mote { x: number; y: number; ch: string; fadeAt: number; phase: number }

export interface Scene { layout: Layout; particles: Particle[]; motes: Mote[]; duration: number }

/** Scatters the dust; `speed` > 1 plays faster (the CLI's setup splash). */
export function assemble(layout: Layout, seed = Date.now(), speed = 1): Scene {
  const rnd = random(seed);
  const between = (a: number, b: number) => a + rnd() * (b - a);
  const k = 1 / speed;
  const particles: Particle[] = layout.glyphs.map((g) => {
    const cone = g.kind === 'cone';
    return {
      ...g,
      sx: between(0, layout.width - 1), sy: between(0, layout.height - 1), bend: between(-0.45, 0.45),
      delay: k * ((cone ? 450 : 1500) + between(0, cone ? 750 : 550)), dur: k * between(850, 1250),
      speck: DUST[Math.floor(between(0, DUST.length))]!,
    };
  });
  const motes: Mote[] = Array.from({ length: Math.round(layout.width * layout.height * 0.08) }, () => ({
    x: Math.floor(between(0, layout.width)), y: Math.floor(between(0, layout.height)),
    ch: DUST[Math.floor(between(0, DUST.length))]!, fadeAt: k * between(1400, 2600), phase: between(0, 6),
  }));
  const duration = Math.max(...particles.map((p) => p.delay + p.dur));
  return { layout, particles, motes, duration };
}

/** A cell of a frame: what to draw and how bright (0 dark … 1 full). */
export interface Cell { ch: string; level: number }

const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/** Where a particle is `q` (0…1) of the way along its arc. */
export function arcPoint(p: Particle, q: number): { x: number; y: number } {
  const e = ease(q);
  const dx = p.x - p.sx;
  const dy = p.y - p.sy;
  const s = Math.sin(Math.PI * e);
  return { x: p.sx + dx * e - dy * p.bend * s * 1.6, y: p.sy + dy * e + dx * p.bend * s * 0.35 };
}

/** The picture `t` ms into the animation: rows of cells, null where nothing is drawn. */
export function frameAt(scene: Scene, t: number): (Cell | null)[][] {
  const { width, height } = scene.layout;
  const cells: (Cell | null)[][] = Array.from({ length: height }, () => Array<Cell | null>(width).fill(null));
  const put = (x: number, y: number, ch: string, level: number) => {
    const cx = Math.round(x);
    const cy = Math.round(y);
    if (cx >= 0 && cx < width && cy >= 0 && cy < height) cells[cy]![cx] = { ch, level };
  };
  const appear = Math.min(1, t / 300);
  for (const m of scene.motes) {
    const a = appear * Math.max(0, 1 - (t - m.fadeAt) / 700);
    if (a > 0) put(m.x, m.y, m.ch, (0.16 + 0.27 * a * (0.6 + 0.4 * Math.sin(t / 180 + m.phase))));
  }
  const landed: Particle[] = [];
  for (const p of scene.particles) {
    const q = (t - p.delay) / p.dur;
    if (q <= 0) { put(p.sx, p.sy, p.speck, 0.24 + 0.2 * appear); continue; }
    if (q >= 1) { landed.push(p); continue; }
    const at = arcPoint(p, q);
    put(at.x, at.y, q < 0.35 ? '·' : q < 0.7 ? '•' : (p.kind === 'cone' ? '▪' : '▫'), 0.43 + 0.43 * q);
  }
  for (const p of landed) {
    const since = t - p.delay - p.dur;
    // a flash on landing, then the settled shade
    put(p.x, p.y, p.ch, since < 220 ? 1 : 1 - 0.14 * Math.min(1, (since - 220) / 500));
  }
  return cells;
}

/** The finished picture, for static output (reduced motion, a non-terminal stdout). */
export function finalFrame(layout: Layout): (Cell | null)[][] {
  const cells: (Cell | null)[][] = Array.from({ length: layout.height }, () => Array<Cell | null>(layout.width).fill(null));
  for (const g of layout.glyphs) cells[g.y]![g.x] = { ch: g.ch, level: 0.86 };
  return cells;
}
