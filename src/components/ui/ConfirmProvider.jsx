import React, { createContext, useContext, useState, useCallback } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Button } from './button';

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
  // Âmbar (desativação reversível) usa o token `warning`; exclusão irreversível usa `destructive`.
  const accent = warning
    ? { icon: 'text-warning', ring: 'bg-warning/10 border-warning/30' }
    : { icon: 'text-destructive', ring: 'bg-destructive/10 border-destructive/30' };

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {o && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-[var(--shadow-modal)]">
            <div className="mb-3 flex items-start gap-3">
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${accent.ring}`}>
                <AlertTriangle className={`h-5 w-5 ${accent.icon}`} />
              </div>
              <div className="flex-1 pt-0.5">
                <h3 className="font-heading text-base font-semibold text-foreground">{o.title}</h3>
              </div>
              <button
                onClick={() => finish(false)}
                aria-label="Fechar"
                className="shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {o.description && <p className="mb-3 text-sm text-muted-foreground">{o.description}</p>}

            {Array.isArray(o.impact) && o.impact.length > 0 && (
              <ul className="mb-4 space-y-1.5 rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
                {o.impact.map((line, i) => (
                  <li key={i} className="flex gap-2"><span className={accent.icon}>•</span><span>{line}</span></li>
                ))}
              </ul>
            )}

            {o.requireTypedName && (
              <div className="mb-4">
                <label htmlFor="confirm-typed-name" className="mb-1.5 block text-xs text-foreground">
                  Para confirmar, digite <span className="font-semibold">{o.requireTypedName}</span>
                </label>
                <input
                  id="confirm-typed-name"
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={o.requireTypedName}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => finish(false)}>
                {o.cancelLabel || 'Cancelar'}
              </Button>
              <Button
                variant={warning ? 'default' : 'destructive'}
                size="sm"
                onClick={() => finish(true)}
                disabled={!typedOk}
              >
                {o.confirmLabel || 'Confirmar'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
