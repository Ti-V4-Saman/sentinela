import * as React from 'react';
import { MessageBubble, type ThreadMessage } from './message-bubble';
import { DateSeparator, dateLabel, dayKey } from './date-separator';
import { SystemMessage, isSystemMessage } from './system-message';

// Renderiza uma lista de mensagens (cronológica ASC) com separadores de data e
// agrupamento por remetente. Read-only. Estados (loading/erro/vazio) ficam na view.
export function MessageThread({ messages, isGroup }: { messages: ThreadMessage[]; isGroup?: boolean }) {
  const rows: React.ReactNode[] = [];
  let prevDay: string | null = null;
  let prevSender: string | null = null;

  for (const m of messages) {
    const dk = dayKey(m.at);
    if (dk && dk !== prevDay) {
      rows.push(<DateSeparator key={`sep-${dk}-${m.id}`} label={dateLabel(m.at)} />);
      prevDay = dk;
      prevSender = null;
    }
    if (isSystemMessage(m.type)) {
      rows.push(<SystemMessage key={m.id} text={m.text} />);
      prevSender = null;
      continue;
    }
    const senderKey = m.fromInternal
      ? 'internal'
      : m.direction === 'outgoing'
        ? 'self'
        : (m.sender?.contactId || m.sender?.phone || 'contact');
    const showSender = senderKey !== prevSender;
    rows.push(<MessageBubble key={m.id} message={m} showSender={showSender} isGroup={isGroup} />);
    prevSender = senderKey;
  }

  return <div className="flex flex-col gap-0.5">{rows}</div>;
}
