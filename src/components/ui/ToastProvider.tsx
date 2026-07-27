import * as React from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning' | 'info';
type ToastItem = { id: number; type: ToastType; title?: string; description?: string };
type ToastApi = {
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
};

const ToastCtx = React.createContext<ToastApi | null>(null);
// eslint-disable-next-line react-refresh/only-export-components
export const useToast = () => React.useContext(ToastCtx) as ToastApi;

// Ícone + tom por tipo — o significado vem do ícone + título, nunca só da cor.
const TONE: Record<ToastType, { icon: React.ComponentType<{ className?: string }>; accent: string; strip: string }> = {
  success: { icon: CheckCircle2, accent: 'text-success', strip: 'bg-success' },
  error: { icon: XCircle, accent: 'text-destructive', strip: 'bg-destructive' },
  warning: { icon: AlertTriangle, accent: 'text-warning', strip: 'bg-warning' },
  info: { icon: Info, accent: 'text-info', strip: 'bg-info' },
};

// Toasts empilháveis no canto superior direito, com auto-dismiss (5s).
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const idRef = React.useRef(0);

  const remove = React.useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = React.useCallback((type: ToastType, title: string, description?: string) => {
    const id = ++idRef.current;
    setToasts((list) => [...list, { id, type, title, description }]);
    setTimeout(() => remove(id), 5000);
  }, [remove]);

  const api = React.useMemo<ToastApi>(() => ({
    success: (title, description) => push('success', title, description),
    error: (title, description) => push('error', title, description),
    warning: (title, description) => push('warning', title, description),
    info: (title, description) => push('info', title, description),
  }), [push]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="fixed right-4 top-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => {
          const tone = TONE[t.type];
          const Icon = tone.icon;
          return (
            <div
              key={t.id}
              role="status"
              aria-live="polite"
              className="relative flex items-start gap-3 overflow-hidden rounded-lg border border-border bg-popover px-4 py-3 text-popover-foreground shadow-[var(--shadow-dropdown)] animate-in slide-in-from-right-4 duration-300"
            >
              <span className={`absolute inset-y-0 left-0 w-1 ${tone.strip}`} aria-hidden />
              <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${tone.accent}`} />
              <div className="min-w-0 flex-1">
                {t.title && <div className="text-sm font-semibold text-foreground">{t.title}</div>}
                {t.description && <div className="mt-0.5 text-xs text-muted-foreground">{t.description}</div>}
              </div>
              <button
                onClick={() => remove(t.id)}
                aria-label="Fechar notificação"
                className="shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
