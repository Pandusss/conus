import { assemble, finalFrame, frameAt, logoLayout, type Cell } from '@conus/brand';
import { useEffect, useMemo, useState } from 'react';

/** Glyphs drawn as boxes, so the picture does not depend on which fonts have them. */
const SHAPES: Record<string, string> = { '▮': 'bar', '█': 'full', '▀': 'top', '▄': 'bottom', '▪': 'dot', '▫': 'dot' };

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const canAnimate = () => typeof requestAnimationFrame === 'function' && !reducedMotion();

/**
 * The Conus mark assembling itself out of dust, once (see @conus/brand). Monochrome: it takes the text colour, so it
 * suits both themes. With reduced motion it is simply the finished picture.
 */
export function AssemblingLogo({ className }: { className?: string }) {
  const layout = useMemo(() => logoLayout({ pad: 0 }), []);
  const scene = useMemo(() => assemble(layout), [layout]);
  const [t, setT] = useState<number | null>(() => (canAnimate() ? 0 : null));
  useEffect(() => {
    if (t === null) return;
    let raf = 0;
    const start = performance.now();
    const end = scene.duration + 900;
    const tick = (now: number) => {
      const elapsed = now - start;
      if (elapsed >= end) { setT(null); return; }
      setT(elapsed);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scene]); // once per mount; the initial t only says whether to animate at all
  const cells: (Cell | null)[][] = t === null ? finalFrame(layout) : frameAt(scene, t);
  return (
    <div className={`ascii-logo${className ? ` ${className}` : ''}`} role="img" aria-label="Conus">
      {cells.map((row, y) => (
        <div key={y} className="ascii-row">
          {row.map((c, x) => {
            if (!c) return <span key={x} className="ascii-c" />;
            const shape = SHAPES[c.ch];
            return (
              <span key={x} className={shape ? `ascii-c ascii-${shape}` : 'ascii-c'} style={{ opacity: c.level }}>
                {shape ? null : c.ch}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
