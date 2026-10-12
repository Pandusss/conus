import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeLayer } from './layers';

export interface MenuItem { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean }
export interface MenuGroup { title?: string; items: MenuItem[] }

/**
 * A button that opens a dropdown menu. The list is portalled and positioned against the button, so it is never
 * clipped by a scrolling board column. Arrow keys move between items, Esc and a click outside close it.
 */
export function Menu({ label, children, className = 'icon-btn', groups, disabled, align = 'end' }: {
  /** Accessible name of the button (and of the menu). */
  label: string;
  /** Button content. */
  children: ReactNode;
  className?: string;
  groups: MenuGroup[];
  disabled?: boolean;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEscapeLayer(() => close(true), open);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const h = list.current?.offsetHeight ?? 0;
    const below = r.bottom + 4 + h <= window.innerHeight - 8 || r.top - 4 - h < 8;
    const top = below ? r.bottom + 4 : r.top - 4 - h;
    setStyle(align === 'end' ? { top, right: Math.max(8, window.innerWidth - r.right) } : { top, left: Math.max(8, r.left) });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    const shut = () => setOpen(false);
    document.addEventListener('mousedown', outside);
    window.addEventListener('resize', shut);
    window.addEventListener('scroll', shut, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('resize', shut);
      window.removeEventListener('scroll', shut, true);
    };
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]!.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Tab') close(false);
  };

  return (
    <>
      <button
        ref={button} type="button" className={className} aria-label={label} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? id : undefined} disabled={disabled}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
      >
        {children}
      </button>
      {open && createPortal(
        <div ref={list} id={id} className="menu" role="menu" aria-label={label} style={style} onKeyDown={onKeyDown}>
          {groups.map((g, gi) => (
            <div key={gi} role="group" aria-label={g.title} className="menu-group">
              {g.title && <div className="menu-title" aria-hidden="true">{g.title}</div>}
              {g.items.map((it) => (
                <button
                  key={it.label} type="button" role="menuitem" disabled={it.disabled}
                  className={`menu-item${it.danger ? ' is-danger' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Focus goes back to the button first, so a dialog opened by the item returns focus there.
                    button.current?.focus();
                    setOpen(false);
                    it.onSelect();
                  }}
                >
                  {it.icon}<span>{it.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
