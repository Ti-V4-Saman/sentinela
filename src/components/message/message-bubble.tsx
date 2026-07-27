import * as React from 'react';
import { StickyNote } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ContactTypeBadge } from '@/components/contacts/contact-type-badge';
import { MessageContent } from './media';

export type ThreadMessage = {
  id: string;
  type?: string;
  text?: string | null;
  direction: 'incoming' | 'outgoing';
  fromMe?: boolean;
  fromInternal?: boolean;
  sender?: {
    self?: boolean; name?: string | null; displayName?: string | null; phone?: string | null; contactId?: string | null;
    type?: { id: number; name: string; color?: string | null } | null;
  };
  at?: string;
};

function fmtTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function MessageBubble({
  message, showSender, isGroup,
}: {
  message: ThreadMessage;
  showSender?: boolean;
  isGroup?: boolean;
}) {
  const outgoing = message.direction === 'outgoing';
  const internal = !!message.fromInternal;

  // Nota interna: destaque próprio, centralizado, independente da direção.
  if (internal) {
    return (
      <div className="flex justify-center py-1">
        <div className="max-w-[80%] rounded-lg border border-dashed border-warning/40 bg-warning/10 px-3 py-2">
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-warning">
            <StickyNote className="h-3 w-3" /> Nota interna
          </div>
          <div className="text-foreground"><MessageContent type={message.type} text={message.text} /></div>
          <div className="mt-1 text-right text-[10px] text-muted-foreground">{fmtTime(message.at)}</div>
        </div>
      </div>
    );
  }

  const senderName = message.sender?.displayName || message.sender?.name || (message.sender?.phone ? message.sender.phone : 'Contato');

  return (
    <div className={cn('flex px-1 py-0.5', outgoing ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[78%] rounded-lg px-3 py-2 shadow-[var(--shadow-sm)]',
          outgoing ? 'bg-primary/10 text-foreground' : 'bg-card text-foreground border border-border',
        )}
      >
        {isGroup && !outgoing && showSender && (
          <div className="mb-0.5 flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-primary">{senderName}</span>
            {message.sender?.type && <ContactTypeBadge type={message.sender.type} />}
          </div>
        )}
        <MessageContent type={message.type} text={message.text} />
        <div className={cn('mt-1 text-[10px] text-muted-foreground', outgoing ? 'text-right' : 'text-left')}>
          {outgoing ? 'Enviada' : 'Recebida'} · {fmtTime(message.at)}
        </div>
      </div>
    </div>
  );
}
