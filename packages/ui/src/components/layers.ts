import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

// Open overlays (dialogs, the task drawer, menus, the mobile sidebar) form a stack: Esc closes only the topmost one,
// so Esc in a dialog opened from the drawer closes the dialog and leaves the drawer open.
const stack: { current: () => void }[] = [];

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !stack.length) return;
  e.preventDefault();
  stack[stack.length - 1]!.current();
}

/** Registers an overlay that Esc closes while `active`. */
export function useEscapeLayer(onEscape: () => void, active = true): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const entry = { current: () => ref.current() };
    stack.push(entry);
    if (stack.length === 1) document.addEventListener('keydown', onKeyDown);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) document.removeEventListener('keydown', onKeyDown);
    };
  }, [active]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * Moves focus into `ref` on mount (the element marked `data-autofocus`, else the first focusable, else the container;
 * with `self` the container itself) and gives it back to whatever had it before on unmount.
 */
export function useFocusInside(ref: RefObject<HTMLElement>, opts: { self?: boolean } = {}): void {
  const self = !!opts.self;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (root) {
      const target = self ? root : root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root)[0] ?? root;
      target.focus();
    }
    return () => {
      if (before && before.isConnected && typeof before.focus === 'function') before.focus();
    };
  }, [ref, self]);
}

/** Keeps Tab and Shift+Tab cycling inside `root` (a modal). Events from nested portals outside `root` are left alone. */
export function trapTab(e: ReactKeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== 'Tab' || !root || !root.contains(e.target as Node)) return;
  const items = focusables(root);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
