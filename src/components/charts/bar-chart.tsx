import * as React from 'react';

export type BarDatum = { label: string; value: number; tone?: string };

// Gráfico de barras HORIZONTAIS (SVG, sem dependência). Cores via tokens (var(--color-*)).
// `tone` é um nome de token semântico (info, success, warning, ia, primary…); default 'primary'.
export function BarChart({ data, formatValue }: { data: BarDatum[]; formatValue?: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const fmt = formatValue || ((v: number) => String(v));
  if (data.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">Sem dados no período.</p>;
  return (
    <div className="space-y-2" role="img" aria-label="Gráfico de barras">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-3">
          <span className="w-40 shrink-0 truncate text-sm text-foreground" title={d.label}>{d.label}</span>
          <div className="relative h-6 flex-1 overflow-hidden rounded bg-muted">
            <div
              className="h-full rounded transition-[width]"
              style={{ width: `${(d.value / max) * 100}%`, backgroundColor: `var(--color-${d.tone || 'primary'})`, minWidth: d.value > 0 ? '2px' : 0 }}
            />
          </div>
          <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground">{fmt(d.value)}</span>
        </div>
      ))}
    </div>
  );
}
