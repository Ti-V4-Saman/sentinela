import * as React from 'react';
import { Menu, X } from 'lucide-react';
import { Sidebar } from './Sidebar';

export function AppShell({
  user, activeView, setActiveView, onOpenMeusDados, onOpenServerConfig, onLogout, onHome, children,
}: {
  user: { name?: string; role?: string } | null;
  activeView: string;
  setActiveView: (v: string) => void;
  onOpenMeusDados: () => void;
  onOpenServerConfig?: () => void;
  onLogout: () => void;
  onHome: () => void;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const nav = (key: string) => { setActiveView(key); setMobileOpen(false); };
  const home = () => { onHome(); setMobileOpen(false); };

  return (
    <div className="min-h-screen bg-background">
      {/* Sidebar fixa (desktop) */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 border-r border-sidebar-border md:block">
        <Sidebar user={user} activeView={activeView} onNavigate={nav} onHome={home}
          onOpenMeusDados={onOpenMeusDados} onOpenServerConfig={onOpenServerConfig} onLogout={onLogout} />
      </aside>

      {/* Drawer (mobile) */}
      {mobileOpen && (
        <div className="md:hidden">
          <div className="fixed inset-0 z-40 bg-foreground/40" onClick={() => setMobileOpen(false)} />
          <aside className="fixed inset-y-0 left-0 z-50 w-60 border-r border-sidebar-border shadow-[var(--shadow-modal)]">
            <button onClick={() => setMobileOpen(false)} aria-label="Fechar menu"
              className="absolute right-2 top-3 z-10 rounded-md p-1 text-sidebar-foreground/70 hover:bg-sidebar-accent/50">
              <X className="h-5 w-5" />
            </button>
            <Sidebar user={user} activeView={activeView} onNavigate={nav} onHome={home}
              onOpenMeusDados={onOpenMeusDados} onLogout={onLogout} />
          </aside>
        </div>
      )}

      {/* Conteúdo */}
      <div className="md:pl-60">
        {/* Top bar mobile */}
        <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-3 md:hidden">
          <button onClick={() => setMobileOpen(true)} aria-label="Abrir menu"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-heading text-base font-semibold">Sentinela</span>
        </div>
        {children}
      </div>
    </div>
  );
}
