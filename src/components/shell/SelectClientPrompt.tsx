import * as React from 'react';
import { Building2, MessageSquare, MessagesSquare, Radio, Plug } from 'lucide-react';

// Estado orientativo exibido na VISÃO GLOBAL do superadmin para telas que só operam por cliente
// (Conversas, Grupos, Conexões, Integrações). Não mistura dados de todos os tenants — pede a
// seleção de um cliente.
const COPY: Record<string, { icon: React.ComponentType<{ className?: string }>; title: string; desc: string }> = {
  conversations: { icon: MessageSquare, title: 'Selecione um cliente para ver as conversas', desc: 'Na visão global não há uma caixa operacional única — escolha um cliente no seletor "Cliente ativo" (canto superior esquerdo) para abrir as conversas dele.' },
  groups: { icon: MessagesSquare, title: 'Selecione um cliente para ver os grupos', desc: 'Escolha um cliente no seletor "Cliente ativo" para ver os grupos capturados dele. Relatórios globais agregados continuam disponíveis em Relatórios.' },
  connections: { icon: Radio, title: 'Selecione um cliente para ver as conexões', desc: 'As conexões são geridas por cliente. Escolha um cliente no seletor "Cliente ativo" para visualizá-las.' },
  integrations: { icon: Plug, title: 'Selecione um cliente para ver as integrações', desc: 'A integração de envio por webhook é configurada por cliente. Escolha um cliente no seletor "Cliente ativo" para configurá-la.' },
};

export function SelectClientPrompt({ kind }: { kind: 'conversations' | 'groups' | 'connections' | 'integrations' }) {
  const c = COPY[kind] || COPY.conversations;
  const Icon = c.icon;
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 lg:px-8">
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card px-6 py-20 text-center shadow-[var(--shadow-card)]">
        <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-7 w-7" />
          <span className="absolute -right-1 -bottom-1 flex h-6 w-6 items-center justify-center rounded-full bg-info/15 text-info"><Building2 className="h-3.5 w-3.5" /></span>
        </div>
        <h2 className="font-heading text-lg font-semibold text-foreground">{c.title}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{c.desc}</p>
      </div>
    </main>
  );
}
