import * as React from 'react';
import { FlaskConical } from 'lucide-react';

// Faixa de identificação de ambiente (ex.: "AMBIENTE DE TESTES"). Renderiza apenas quando a variável
// de build VITE_ENV_LABEL estiver definida — em produção fica ausente. Usa tokens do design system.
export function EnvBanner({ className = '' }: { className?: string }) {
  const label = (import.meta.env.VITE_ENV_LABEL || '').toString().trim();
  if (!label) return null;
  return (
    <div
      role="status"
      className={`flex items-center justify-center gap-1.5 border-b border-warning/30 bg-warning/15 px-3 py-1.5 text-center text-xs font-semibold uppercase tracking-wide text-warning ${className}`}
    >
      <FlaskConical className="h-3.5 w-3.5" aria-hidden />
      {label}
    </div>
  );
}
