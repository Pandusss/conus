import { assemble, finalFrame, frameAt, logoLayout, type Cell } from '@conus/brand';

/** An interactive terminal: present only when stdout is a TTY worth animating (see main.ts). */
export interface Terminal {
  columns: number;
  write(s: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Runs `restore` if the user interrupts; returns the function that removes the handler. */
  onInterrupt(restore: () => void): () => void;
}

/** Glyphs a terminal may lack (the Windows console's fonts): their plainer stand-ins. */
const PLAIN: Record<string, string> = { '▮': '█', '▪': '■', '▫': '□', '˙': "'", '∙': '·' };

export interface PaintOptions { color: boolean; plain: boolean }

/** One frame as terminal lines: brightness becomes a grey from the 256-colour ramp (232 black … 255 white). */
export function paint(cells: (Cell | null)[][], opts: PaintOptions, overlay?: { x: number; y: number; text: string; cursor: boolean }): string[] {
  return cells.map((row, y) => {
    let out = '';
    let last = -1;
    const chars = row.map((c) => (c ? { ...c, ch: opts.plain ? (PLAIN[c.ch] ?? c.ch) : c.ch } : null));
    if (overlay && overlay.y === y) {
      [...overlay.text].forEach((ch, i) => { chars[overlay.x + i] = { ch, level: 0.55 }; });
      if (overlay.cursor) chars[overlay.x + overlay.text.length] = { ch: '▌', level: 0.8 };
    }
    for (const c of chars) {
      if (!c) { out += ' '; continue; }
      if (opts.color) {
        const grey = 232 + Math.round(Math.max(0, Math.min(1, c.level)) * 23);
        if (grey !== last) { out += `\x1b[38;5;${grey}m`; last = grey; }
      }
      out += c.ch;
    }
    return (opts.color ? out + '\x1b[0m' : out).replace(/\s+$/, '');
  });
}

/** The finished logo as text, for `conus logo` outside a terminal. */
export function staticLogo(tagline: string, opts: PaintOptions): string {
  const layout = logoLayout({ textWidth: tagline.length });
  return paint(finalFrame(layout), opts, { ...layout.textAt!, text: tagline, cursor: false }).join('\n');
}

const FRAME_MS = 33;

/**
 * Plays the assembly in place: the frame is redrawn over itself, the cursor is hidden meanwhile and always comes
 * back (also on Ctrl-C). `speed` > 1 is the quicker version for `conus setup`; without a tagline it ends sooner.
 */
export async function playLogo(term: Terminal, opts: { tagline?: string; speed?: number; plain: boolean }): Promise<void> {
  const tagline = opts.tagline ?? '';
  const layout = logoLayout({ textWidth: tagline.length });
  if (term.columns < layout.width) return;
  const scene = assemble(layout, term.now(), opts.speed ?? 1);
  const typeFrom = scene.duration + 120;
  const end = tagline ? typeFrom + tagline.length * 28 + 500 : scene.duration + 250;
  const restore = () => term.write('\x1b[0m\x1b[?25h');
  const off = term.onInterrupt(restore);
  term.write('\x1b[?25l' + '\n'.repeat(layout.height));
  try {
    const started = term.now();
    for (;;) {
      const t = term.now() - started;
      const typed = tagline && t > typeFrom ? Math.min(tagline.length, Math.floor((t - typeFrom) / 28)) : 0;
      const blink = t < end && t > typeFrom && (typed < tagline.length || Math.floor(t / 500) % 2 === 0);
      const overlay = tagline ? { ...layout.textAt!, text: tagline.slice(0, typed), cursor: blink } : undefined;
      const lines = paint(frameAt(scene, Math.min(t, end)), { color: true, plain: opts.plain }, overlay);
      term.write(`\x1b[${layout.height}F` + lines.map((l) => l + '\x1b[K').join('\n') + '\n');
      if (t >= end) break;
      await term.sleep(FRAME_MS);
    }
  } finally {
    restore();
    off();
  }
}
