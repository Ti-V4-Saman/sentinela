import * as React from 'react';

export type Series = { name: string; tone: string; points: number[] };

// Gráfico de linhas (SVG viewBox, responsivo). Multi-série; cores via tokens var(--color-*).
// `labels` são rótulos do eixo X (ex.: datas). Sem dependência externa.
export function LineChart({ labels, series, height = 220 }: { labels: string[]; series: Series[]; height?: number }) {
  const W = 640; const H = height; const padL = 36; const padB = 24; const padT = 10; const padR = 10;
  const n = labels.length;
  const allVals = series.flatMap((s) => s.points);
  const max = Math.max(1, ...allVals);
  if (n === 0) return <p className="py-8 text-center text-sm text-muted-foreground">Sem dados no período.</p>;

  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
  const path = (pts: number[]) => pts.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');

  // até 5 rótulos no eixo X para não poluir
  const tickIdx = n <= 6 ? labels.map((_, i) => i) : [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1];

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: H }} role="img" aria-label="Gráfico de linhas">
        {/* grade horizontal + eixo Y (3 marcas) */}
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W - padR} y1={y(max * f)} y2={y(max * f)} stroke="var(--color-border)" strokeWidth="1" />
            <text x={padL - 6} y={y(max * f) + 3} textAnchor="end" fontSize="10" fill="var(--color-muted-foreground)">{Math.round(max * f)}</text>
          </g>
        ))}
        {/* rótulos X */}
        {tickIdx.map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize="9" fill="var(--color-muted-foreground)">{labels[i]?.slice(5) || labels[i]}</text>
        ))}
        {/* séries */}
        {series.map((s) => (
          <path key={s.name} d={path(s.points)} fill="none" stroke={`var(--color-${s.tone})`} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap gap-4">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2 w-3 rounded-sm" style={{ backgroundColor: `var(--color-${s.tone})` }} /> {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
