import * as React from 'react';
import { Info } from 'lucide-react';

// Mensagem de sistema (entrou/saiu do grupo, etc.) — centralizada e discreta.
export function SystemMessage({ text }: { text?: string | null }) {
  return (
    <div className="flex justify-center py-1">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-[11px] text-muted-foreground">
        <Info className="h-3 w-3" /> {text || 'Evento do sistema'}
      </span>
    </div>
  );
}

// Tipos tratados como mensagem de sistema (defensivo — o schema não marca explicitamente).
const SYSTEM_TYPES = new Set(['system', 'notification', 'e2e_notification', 'gp2', 'call_log']);
export const isSystemMessage = (type?: string) => !!type && SYSTEM_TYPES.has(type);
