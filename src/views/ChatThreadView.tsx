import * as React from 'react';
import { ArrowLeft, Loader2, AlertCircle, MessageSquare, Users as UsersIcon, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/badge';
import { MessageThread, type ThreadMessage } from '@/components/message';
import { listMessages } from '../services/chatsApi';
import { friendlyError } from '../utils/validation';

const PAGE = 50;

type Chat = { id: string; ref?: string; title?: string | null; isGroup?: boolean; contact?: { name?: string | null; phone?: string | null } };

export function ChatThreadView({ chat, onBack }: { chat: Chat; onBack: () => void }) {
  const [messages, setMessages] = React.useState<ThreadMessage[]>([]);
  const [page, setPage] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState('');
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  const key = chat.ref || chat.id;

  const fetchPage = React.useCallback(async (p: number, signal: AbortSignal) => {
    return listMessages(key, { page: p, limit: PAGE }, signal);
  }, [key]);

  // Carga inicial (cancela ao trocar de conversa/desmontar).
  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true); setError(''); setMessages([]); setPage(1);
    (async () => {
      try {
        const res = await fetchPage(1, ac.signal);
        setMessages(res.messages); setTotal(res.total); setPage(1);
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(friendlyError((e as Error).message) || 'Falha ao carregar as mensagens');
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [fetchPage]);

  const loadMore = async () => {
    const ac = new AbortController();
    setLoadingMore(true);
    try {
      const next = page + 1;
      const res = await fetchPage(next, ac.signal);
      setMessages((prev) => [...prev, ...res.messages]);
      setTotal(res.total); setPage(next);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(friendlyError((e as Error).message) || 'Falha ao carregar mais');
    } finally {
      setLoadingMore(false);
    }
  };

  const hasMore = messages.length < total;
  const title = chat.title || chat.contact?.name || chat.contact?.phone || 'Conversa';

  return (
    <main className="mx-auto flex h-[calc(100vh-1px)] w-full max-w-3xl flex-col px-4 py-4 lg:px-8">
      {/* Cabeçalho da thread */}
      <div className="mb-3 flex items-center gap-3 border-b border-border pb-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Voltar para a lista">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {chat.isGroup ? <UsersIcon className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-heading text-base font-semibold text-foreground">{title}</h1>
          <p className="text-xs text-muted-foreground">
            {chat.isGroup ? 'Grupo' : 'Conversa individual'} · somente leitura
          </p>
        </div>
        {chat.isGroup && <StatusBadge tone="neutral">Grupo</StatusBadge>}
      </div>

      {/* Conteúdo */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-background/50 p-3">
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"><AlertCircle className="h-6 w-6" /></div>
            <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={() => { setPage(1); setError(''); setLoading(true); onBack(); }}>Voltar</Button>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <MessageSquare className="h-8 w-8" />
            <p className="text-sm">Nenhuma mensagem nesta conversa.</p>
          </div>
        ) : (
          <>
            {hasMore && (
              <div className="mb-2 flex justify-center">
                <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />} Carregar mais mensagens
                </Button>
              </div>
            )}
            <MessageThread messages={messages} isGroup={chat.isGroup} />
            <div ref={bottomRef} />
          </>
        )}
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">{total} mensagem(ns)</p>
    </main>
  );
}
