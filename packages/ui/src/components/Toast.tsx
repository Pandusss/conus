import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleCheck } from 'lucide-react';
import { useT } from '../i18n';

type Push = (text: string) => void;
const Ctx = createContext<Push>(() => {});
const TTL = 3_500;

/** Short confirmations of successful actions («WB-3 → Done»). Errors stay on the page as ErrorLine. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback<Push>((text) => {
    const id = ++seq.current;
    setToasts((all) => [...all.slice(-2), { id, text }]);
    const timer = setTimeout(() => { timers.current.delete(timer); dismiss(id); }, TTL);
    timers.current.add(timer);
  }, [dismiss]);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <button key={toast.id} type="button" className="toast" onClick={() => dismiss(toast.id)} title={t.common.dismiss}>
            <CircleCheck size={16} aria-hidden />
            <span>{toast.text}</span>
          </button>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** Shows a toast; outside a provider (isolated page tests) it does nothing. */
export const useToast = (): Push => useContext(Ctx);
