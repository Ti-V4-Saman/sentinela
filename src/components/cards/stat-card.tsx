import * as React from 'react';
import { type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type StatTone = 'primary' | 'success' | 'destructive' | 'info' | 'ia' | 'neutral';

const ICON_TONE: Record<StatTone, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  destructive: 'bg-destructive/10 text-destructive',
  info: 'bg-info/10 text-info',
  ia: 'bg-ia/10 text-ia',
  neutral: 'bg-muted text-muted-foreground',
};

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
  hint,
  className,
}: {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  tone?: StatTone;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-4 rounded-lg border border-border bg-card p-4 shadow-[var(--shadow-card)]',
        className,
      )}
    >
      {Icon && (
        <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-md', ICON_TONE[tone])}>
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="font-heading text-2xl font-semibold text-foreground leading-tight">{value}</p>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
    </div>
  );
}
