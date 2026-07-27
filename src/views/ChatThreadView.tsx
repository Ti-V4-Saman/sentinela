import * as React from 'react';
import { ArrowLeft, Loader2, AlertCircle, MessageSquare, Users as UsersIcon, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/badge';
import { MessageThread, type ThreadMessage } from '@/components/message';
import { prependOlder } from '@/utils/thread';
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
  const [error, setError] = React.useState('');          // erro da carga inicial (substitui a thread)
  const [moreError, setMoreError] = React.useState('');  // erro ao paginar (NÃO apaga o histórico)
  const [reloadKey, setReloadKey] = React.useState(0);   // dispara nova carga inicial (retry)

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  // Ajuste de scroll pendente após prepend (preserva a posição visual).
  const pendingAdjust = React.useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const key = chat.ref || chat.id;
  // A chave da conversa vigente; usada para descartar respostas de paginação após troca rápida.
  const keyRef = React.useRef(key);
  keyRef.current = key;

  // Carga inicial: página 1 = as PAGE mensagens MAIS RECENTES (em ordem cronológica).
  // Cancela ao trocar de conversa/desmontar e ao pedir retry (reloadKey).
  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true); setError(''); setMoreError(''); setMessages([]); setPage(1);
    pendingAdjust.current = null;
    (async () => {
      try {
        const res = await listMessages(key, { page: 1, limit: PAGE }, ac.signal);
        setMessages(res.messages); setTotal(res.total); setPage(1);
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(friendlyError((e as Error).message) || 'Falha ao carregar as mensagens');
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [key, reloadKey]);

  // Após um prepend, restaura a posição de scroll para não haver salto.
  React.useLayoutEffect(() => {
    const adj = pendingAdjust.current;
    const el = scrollRef.current;
    if (adj && el) {
      el.scrollTop = el.scrollHeight - adj.prevHeight + adj.prevTop;
      pendingAdjust.current = null;
    }
  }, [messages]);

  // Carrega a página anterior (mensagens mais antigas) e faz prepend no topo.
  const loadOlder = async () => {
    const myKey = key;
    const ac = new AbortController();
    setLoadingMore(true); setMoreError('');
    const el = scrollRef.current;
    const snapshot = el ? { prevHeight: el.scrollHeight, prevTop: el.scrollTop } : null;
    try {
      const next = page + 1;
      const res = await listMessages(myKey, { page: next, limit: PAGE }, ac.signal);
      if (keyRef.current !== myKey) return; // conversa mudou durante o fetch → descarta
      pendingAdjust.current = snapshot;
      setMessages((prev) => prependOlder(prev, res.messages));
      setTotal(res.total); setPage(next);
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && keyRef.current === myKey) {
        setMoreError(friendlyError((e as Error).message) || 'Falha ao carregar mensagens anteriores');
      }
    } finally {
      if (keyRef.current === myKey) setLoadingMore(false);
    }
  };

  const hasMore = messages.length < total;
  const title = chat.title || chat.contact?.name || chat.contact?.phone || 'Conversa';

  return (
    <main className="mx-auto flex h-[calc(100vh-1px)] w-full max-w-3xl flex-col px-4 py-4 lg:px-8">
      {/* Cabeçalho da thread */}
      <div className="mb-3 flex items-center gap-3 border-b border-border pb-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Voltar para conversas">
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-background/50 p-3">
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"><AlertCircle className="h-6 w-6" /></div>
            <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                <RotateCw className="h-3.5 w-3.5" /> Tentar novamente
              </Button>
              <Button variant="ghost" size="sm" onClick={onBack}>Voltar para conversas</Button>
            </div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <MessageSquare className="h-8 w-8" />
            <p className="text-sm">Nenhuma mensagem nesta conversa.</p>
          </div>
        ) : (
          <>
            {hasMore && (
              <div className="mb-2 flex flex-col items-center gap-1">
                <Button variant="outline" size="sm" onClick={loadOlder} disabled={loadingMore}>
                  {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />} Carregar mensagens anteriores
                </Button>
                {moreError && <span className="text-xs text-destructive">{moreError}</span>}
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
