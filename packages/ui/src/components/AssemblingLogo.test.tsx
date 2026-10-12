import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { logoLayout } from '@conus/brand';
import { AssemblingLogo } from './AssemblingLogo';

afterEach(() => vi.unstubAllGlobals());

describe('AssemblingLogo', () => {
  it('shows the finished mark at once when the system asks for reduced motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));
    const { container } = render(<AssemblingLogo />);
    expect(screen.getByRole('img', { name: 'Conus' })).toBeTruthy();
    const cone = logoLayout({ pad: 0 }).glyphs.filter((g) => g.kind === 'cone').length;
    expect(container.querySelectorAll('.ascii-bar')).toHaveLength(cone);
    expect(container.querySelectorAll('.ascii-top, .ascii-bottom, .ascii-full').length).toBeGreaterThan(20);
  });

  it('starts as dust when it may move', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { container } = render(<AssemblingLogo />);
    expect(container.querySelectorAll('.ascii-bar')).toHaveLength(0);
    expect([...container.querySelectorAll('.ascii-c')].some((c) => c.textContent)).toBe(true);
  });
});
