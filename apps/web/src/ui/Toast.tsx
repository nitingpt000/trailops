import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import type { Tone } from '../api/commands';

interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  message?: string;
}

const ToastContext = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => undefined);

const ICON = { success: CircleCheck, warning: TriangleAlert, error: CircleAlert, info: Info } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), t.tone === 'success' ? 5000 : 9000);
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => {
          const Icon = ICON[t.tone];
          return (
            <div key={t.id} className={`toast toast-${t.tone}`}>
              <Icon size={20} aria-hidden />
              <div>
                <strong>{t.title}</strong>
                {t.message && <p>{t.message}</p>}
              </div>
              <button className="icon-btn" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
