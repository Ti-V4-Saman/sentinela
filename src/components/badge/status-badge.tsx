import * as React from 'react';
import { cn } from '@/lib/utils';

export type StatusTone = 'success' | 'destructive' | 'warning' | 'alert' | 'info' | 'ia' | 'neutral';

// Classes completas por tom (strings inteiras para o Tailwind detectar no scan).
const TONE: Record<StatusTone, string> = {
  success: 'bg-success/10 text-success border-success/30',
  destructive: 'bg-destructive/10 text-destructive border-destructive/30',
  warning: 'bg-warning/10 text-warning border-warning/30',
  alert: 'bg-alert/10 text-alert border-alert/30',
  info: 'bg-info/10 text-info border-info/30',
  ia: 'bg-ia/10 text-ia border-ia/30',
  neutral: 'bg-muted text-muted-foreground border-border',
};

const DOT: Record<StatusTone, string> = {
  success: 'bg-success',
  destructive: 'bg-destructive',
  warning: 'bg-warning',
  alert: 'bg-alert',
  info: 'bg-info',
  ia: 'bg-ia',
  neutral: 'bg-muted-foreground',
};

export function StatusBadge({
  tone = 'neutral',
  dot = true,
  className,
  children,
}: {
  tone?: StatusTone;
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        TONE[tone],
        className,
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', DOT[tone])} aria-hidden />}
      {children}
    </span>
  );
}
