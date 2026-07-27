import * as React from 'react';
import { StatusBadge, type StatusTone } from '@/components/badge';

export type ContactType = { id: number; name: string; color?: string | null };

// As cores dos tipos são exatamente as tones do StatusBadge (validadas no backend).
// Fallback defensivo: 'neutral' se vier algo fora da lista.
const TONES: StatusTone[] = ['success', 'destructive', 'warning', 'alert', 'info', 'ia', 'neutral'];
function toTone(color?: string | null): StatusTone {
  return TONES.includes(color as StatusTone) ? (color as StatusTone) : 'neutral';
}

export function ContactTypeBadge({ type, className }: { type: ContactType; className?: string }) {
  return <StatusBadge tone={toTone(type.color)} dot className={className}>{type.name}</StatusBadge>;
}
