import React, { createContext, useContext, useState, useCallback } from 'react';
import { AlertTriangle, X } from 'lucide-react';

const ConfirmCtx = createContext(null);
export const useConfirm = () => useContext(ConfirmCtx);

/**
 * confirm(options) => Promise<boolean>
 * options: {
 *   title, description,
 *   impact?: string[]            // lista do impacto em cascata
 *   variant?: 'danger'|'warning' // vermelho (exclusão) | âmbar (desativação)
 *   confirmLabel?: string        // texto do botão de ação (ex: "Excluir permanentemente")
 *   cancelLabel?: string
 *   requireTypedName?: string    // se setado, exige digitar exatamente esse texto
 * }
 */
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null); // { options, resolve }
  const [typed, setTyped] = useState('');

  const confirm = useCallback((options) => new Promise((resolve) => {
    setTyped('');
    setState({ options: options || {}, resolve });
  }), []);

  const finish = (result) => { state?.resolve(result); setState(null); };

  const o = state?.options;
  const warning = o?.variant === 'warning';
  const typedOk = !o?.requireTypedName || typed === o.requireTypedName;
  const accent = warning
    ? { icon: 'text-amber-400', ring: 'bg-amber-500/10 border-amber-500/30', btn: 'bg-amber-500 hover:bg-amber-600 text-black' }
    : { icon: 'text-rose-400', ring: 'bg-rose-500/10 border-rose-500/30', btn: 'bg-danger hover:bg-danger-hover text-white' };

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {o && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md bg-dark-card border border-dark-border rounded-2xl p-6">
            <div className="flex items-start gap-3 mb-3">
              <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${accent.ring}`}>
                <AlertTriangle className={`w-5 h-5 ${accent.icon}`} />
              </div>
              <div className="flex-1 pt-0.5">
                <h3 className="text-base font-bold font-outfit text-white">{o.title}</h3>
              </div>
              <button onClick={() => finish(false)} className="text-slate-400 hover:text-white shrink-0"><X className="w-5 h-5" /></button>
            </div>

            {o.description && <p className="text-sm text-slate-300 mb-3">{o.description}</p>}

            {Array.isArray(o.impact) && o.impact.length > 0 && (
              <ul className="text-xs text-slate-400 bg-dark-input border border-dark-border rounded-lg p-3 mb-4 space-y-1.5">
                {o.impact.map((line, i) => (
                  <li key={i} className="flex gap-2"><span className={accent.icon}>•</span><span>{line}</span></li>
                ))}
              </ul>
            )}

            {o.requireTypedName && (
              <div className="mb-4">
                <label className="block text-xs text-slate-300 mb-1.5">
                  Para confirmar, digite <span className="font-semibold text-white">{o.requireTypedName}</span>
                </label>
                <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)}
                  className="w-full bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-rose-500/60"
                  placeholder={o.requireTypedName} />
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={() => finish(false)} className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white">
                {o.cancelLabel || 'Cancelar'}
              </button>
              <button onClick={() => finish(true)} disabled={!typedOk}
                className={`px-4 py-2 text-xs font-semibold rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${accent.btn}`}>
                {o.confirmLabel || 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
