import * as React from 'react';
import { Building2, LogOut } from 'lucide-react';
import { useTenant } from '@/context/TenantContext';

// Tarja fixa exibida quando o superadmin está no MODO CLIENTE. Visualmente distinta do banner
// "AMBIENTE DE TESTES" (tom `info`, não `warning`) — os dois podem coexistir empilhados sem sobrepor.
export function TenantBanner() {
  const { activeTenant, exitClient } = useTenant();
  if (!activeTenant) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-info/30 bg-info/10 px-4 py-2 text-sm text-info">
      <span className="inline-flex items-center gap-2">
        <Building2 className="h-4 w-4 shrink-0" />
        <span>
          Você está atuando como <span className="font-semibold">{activeTenant.name}</span> — tudo que
          cadastrar, editar ou visualizar agora pertence a este cliente.
        </span>
      </span>
      <button
        onClick={exitClient}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-info/40 bg-background/40 px-2.5 py-1 text-xs font-medium text-info transition-colors hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <LogOut className="h-3.5 w-3.5" /> Sair do modo cliente
      </button>
    </div>
  );
}
