// The README's animated logo: the same assembly as `conus logo` and the web app's login (@conus/brand), as SVG with
// SMIL animation, so GitHub plays it inside an <img>. Shapes instead of glyphs: no font decides the picture.
// One file per GitHub theme. Run `npm run gen:icon` after changing @conus/brand or this script.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arcPoint, assemble, logoLayout, type Glyph } from '../packages/brand/src';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CW = 9; // character cell, px
const CH = 17;
const SEED = 30; // Rule 30
const f = (n: number) => Number(n.toFixed(2)).toString();
const s = (ms: number) => `${f(ms / 1000)}s`;

/** The rectangles a glyph is drawn with, in cell units of the grid. */
function shapes(g: Glyph): [x: number, y: number, w: number, h: number][] {
  const x = g.x * CW;
  const y = g.y * CH;
  switch (g.ch) {
    case '▮': return [[x + CW * 0.2, y + CH * 0.1, CW * 0.58, CH * 0.8]];
    case '█': return [[x, y, CW + 0.4, CH + 0.4]];
    case '▀': return [[x, y, CW + 0.4, CH / 2 + 0.4]];
    case '▄': return [[x, y + CH / 2, CW + 0.4, CH / 2 + 0.4]];
    default: return [];
  }
}

function svg(ink: string): string {
  const layout = logoLayout({ pad: 2 });
  const scene = assemble(layout, SEED);
  const width = layout.width * CW;
  const height = layout.height * CH;
  const centre = (x: number, y: number) => [x * CW + CW / 2, y * CH + CH / 2] as const;
  const parts: string[] = [];

  for (const m of scene.motes) {
    const [cx, cy] = centre(m.x, m.y);
    parts.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="0.9" opacity="0"><animate attributeName="opacity" values="0;0.32;0.32;0" keyTimes="0;0.15;${f(m.fadeAt / (m.fadeAt + 700))};1" dur="${s(m.fadeAt + 700)}" fill="freeze"/></circle>`);
  }
  for (const p of scene.particles) {
    const [sx, sy] = centre(p.sx, p.sy);
    const [tx, ty] = centre(p.x, p.y);
    const mid = arcPoint(p, 0.5);
    const [mx, my] = centre(mid.x, mid.y);
    // a quadratic curve through the arc's midpoint, relative to the speck's resting place
    const qx = 2 * mx - (sx + tx) / 2 - sx;
    const qy = 2 * my - (sy + ty) / 2 - sy;
    const landAt = p.delay + p.dur;
    const k = (ms: number) => f(ms / landAt);
    parts.push(
      `<circle cx="${f(sx)}" cy="${f(sy)}" r="1.1" opacity="0">` +
      `<animate attributeName="opacity" values="0;0.4;0.4;0.95;0" keyTimes="0;${k(300)};${k(p.delay)};${k(landAt - 40)};1" dur="${s(landAt)}" fill="freeze"/>` +
      `<animate attributeName="r" values="1.1;2.1" begin="${s(p.delay)}" dur="${s(p.dur)}" fill="freeze"/>` +
      `<animateMotion path="M0,0 Q${f(qx)},${f(qy)} ${f(tx - sx)},${f(ty - sy)}" begin="${s(p.delay)}" dur="${s(p.dur)}" fill="freeze" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="0.65 0 0.35 1"/>` +
      `</circle>`,
    );
    for (const [x, y, w, h] of shapes(p)) {
      parts.push(
        `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"${p.ch === '▮' ? ' rx="1"' : ''} opacity="0">` +
        `<animate attributeName="opacity" values="1;0.86" begin="${s(landAt)}" dur="0.7s" fill="freeze"/></rect>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Conus">
<title>Conus</title>
<g fill="${ink}">
${parts.join('\n')}
</g>
</svg>
`;
}

const write = (rel: string, text: string) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log('wrote', rel, `${(text.length / 1024).toFixed(0)} KB`);
};
// GitHub's default text colours of its light and dark themes
write('docs/assets/conus-animated-light.svg', svg('#1f2328'));
write('docs/assets/conus-animated-dark.svg', svg('#e6edf3'));
