import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';

const ToastCtx = createContext(null);
export const useToast = () => useContext(ToastCtx);

// Toasts empilháveis no canto superior direito, com auto-dismiss.
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const remove = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback((type, title, description) => {
    const id = ++idRef.current;
    setToasts((list) => [...list, { id, type, title, description }]);
    setTimeout(() => remove(id), 5000);
  }, [remove]);

  const api = {
    success: (title, description) => push('success', title, description),
    error: (title, description) => push('error', title, description),
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
        {toasts.map((t) => {
          const ok = t.type === 'success';
          return (
            <div key={t.id}
              className={`flex items-start gap-3 rounded-xl border shadow-xl px-4 py-3 animate-in slide-in-from-right-4 duration-300 ${
                ok ? 'bg-emerald-950 border-emerald-800' : 'bg-rose-950 border-rose-800'
              }`}>
              {ok ? <CheckCircle2 className="w-5 h-5 text-brand-emerald shrink-0 mt-0.5" />
                  : <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />}
              <div className="flex-1 min-w-0">
                {t.title && <div className={`text-sm font-semibold ${ok ? 'text-emerald-200' : 'text-rose-200'}`}>{t.title}</div>}
                {t.description && <div className="text-xs text-slate-300 mt-0.5">{t.description}</div>}
              </div>
              <button onClick={() => remove(t.id)} className="text-slate-400 hover:text-white shrink-0"><X className="w-4 h-4" /></button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
