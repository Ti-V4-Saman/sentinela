import * as React from 'react';
import {
  ShieldCheck, Radio, Building2, Users, UsersRound,
  Settings, LogOut, Sun, Moon, ChevronsUpDown, Server, MessageSquare, MessagesSquare, Contact,
  LayoutDashboard, BarChart3, ScrollText, Globe, Search, Check, LogOut as ExitIcon, ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { getTheme, toggleTheme, type Theme } from '@/utils/theme';
import { useTenant } from '@/context/TenantContext';
import { listTenants } from '../../services/adminApi';

type Role = 'superadmin' | 'admin' | 'gestor' | 'usuario';
type NavKey = 'dashboard' | 'conversations' | 'groups' | 'contacts' | 'instances'
  | 'tenants' | 'users' | 'teams' | 'reports' | 'audit';

const ROLE_LABELS: Record<string, string> = {
  superadmin: 'Superadmin', admin: 'Administrador', gestor: 'Gestor', usuario: 'Usuário',
};

const ALL: Role[] = ['superadmin', 'admin', 'gestor', 'usuario'];
type Item = { key: NavKey; label: string; icon: React.ComponentType<{ className?: string }>; roles: Role[] };

// Menu principal. "instances" (Conexões) tem regra própria de visibilidade (ver visibleMain).
const NAV_MAIN: Item[] = [
  { key: 'dashboard', label: 'Painel', icon: LayoutDashboard, roles: ['superadmin', 'admin'] },
  { key: 'conversations', label: 'Conversas', icon: MessageSquare, roles: ALL },
  { key: 'groups', label: 'Grupos', icon: MessagesSquare, roles: ALL },
  { key: 'contacts', label: 'Contatos', icon: Contact, roles: ['superadmin', 'admin'] },
  { key: 'reports', label: 'Relatórios', icon: BarChart3, roles: ['superadmin', 'admin'] },
  { key: 'audit', label: 'Auditoria', icon: ScrollText, roles: ['superadmin', 'admin'] },
  { key: 'instances', label: 'Conexões', icon: Radio, roles: ['admin', 'gestor', 'usuario'] },
];
// Configurações (recolhível).
const NAV_SETTINGS: Item[] = [
  { key: 'tenants', label: 'Clientes', icon: Building2, roles: ['superadmin'] },
  { key: 'users', label: 'Usuários', icon: Users, roles: ['superadmin', 'admin'] },
  { key: 'teams', label: 'Equipes', icon: UsersRound, roles: ['superadmin', 'admin'] },
];

type Tenant = { id: number; name: string; status?: string };

// Seletor de cliente ativo (só superadmin).
function TenantSelector() {
  const { activeTenant, selectTenant, exitClient } = useTenant();
  const [tenants, setTenants] = React.useState<Tenant[]>([]);
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (open && tenants.length === 0) listTenants().then(setTenants).catch(() => {});
  }, [open, tenants.length]);

  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? tenants.filter((t) => t.name.toLowerCase().includes(s) || String(t.id).includes(s.replace('#', ''))) : tenants;
  }, [tenants, q]);

  return (
    <div className="px-3 pb-2">
      <span className="mb-1 block px-1 text-[10px] font-medium uppercase tracking-wide text-sidebar-foreground/50">Cliente ativo</span>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className="flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/30 px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50"
            aria-label="Selecionar cliente ativo"
          >
            {activeTenant ? <Building2 className="h-4 w-4 shrink-0 text-sidebar-foreground/70" /> : <Globe className="h-4 w-4 shrink-0 text-sidebar-foreground/70" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{activeTenant ? activeTenant.name : 'Visão global'}</span>
              {activeTenant && <span className="block truncate text-[10px] text-sidebar-foreground/60">Cliente #{activeTenant.id}</span>}
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-sidebar-foreground/60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56 p-0">
          <div className="border-b border-border p-2">
            <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar cliente…"
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            <DropdownMenuItem onClick={() => exitClient()}>
              <Globe className="h-4 w-4" /> Visão global
              {!activeTenant && <Check className="ml-auto h-3.5 w-3.5" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">Nenhum cliente.</p>
            ) : filtered.map((t) => (
              <DropdownMenuItem key={t.id} onClick={() => selectTenant(t.id)}>
                <Building2 className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate">{t.name} <span className="text-muted-foreground">#{t.id}</span></span>
                {activeTenant?.id === t.id && <Check className="ml-auto h-3.5 w-3.5" />}
              </DropdownMenuItem>
            ))}
          </div>
          {activeTenant && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => exitClient()}>
                <ExitIcon className="h-4 w-4" /> Sair do cliente
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function NavButton({ item, active, onClick }: { item: Item; active: boolean; onClick: () => void }) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
        active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {item.label}
    </button>
  );
}

export function Sidebar({
  user, activeView, onNavigate, onHome, onOpenMeusDados, onOpenServerConfig, onLogout,
}: {
  user: { name?: string; role?: string } | null;
  activeView: string;
  onNavigate: (key: NavKey) => void;
  onHome: () => void;
  onOpenMeusDados: () => void;
  onOpenServerConfig?: () => void;
  onLogout: () => void;
}) {
  const [theme, setTheme] = React.useState<Theme>(getTheme());
  const [settingsOpen, setSettingsOpen] = React.useState(true);
  const { isSuper, activeTenant } = useTenant();
  const role = (user?.role || '') as Role;

  // Conexões: admin/gestor/usuario (papel) sempre; superadmin só no modo cliente.
  const visibleMain = NAV_MAIN.filter((i) => {
    if (i.key === 'instances') {
      if (isSuper) return !!activeTenant;
      return i.roles.includes(role);
    }
    return i.roles.includes(role);
  });
  const visibleSettings = NAV_SETTINGS.filter((i) => i.roles.includes(role));
  const initial = (user?.name || 'U').charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-60 flex-col bg-sidebar text-sidebar-foreground">
      {/* Logo */}
      <button onClick={onHome} className="flex items-center gap-2.5 px-4 py-4 text-left transition-opacity hover:opacity-90" title="Início">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div>
          <p className="font-heading text-base font-semibold leading-none">Sentinela</p>
          <p className="text-[10px] text-sidebar-foreground/60">Monitoramento WhatsApp</p>
        </div>
      </button>

      {/* Seletor de cliente (só superadmin) */}
      {isSuper && <TenantSelector />}

      {/* Navegação */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {visibleMain.map((item) => (
          <NavButton key={item.key} item={item} active={activeView === item.key} onClick={() => onNavigate(item.key)} />
        ))}

        {visibleSettings.length > 0 && (
          <div className="pt-2">
            <button
              onClick={() => setSettingsOpen((v) => !v)}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50"
              aria-expanded={settingsOpen}
            >
              <Settings className="h-4 w-4 shrink-0" /> Configurações
              {settingsOpen ? <ChevronDown className="ml-auto h-4 w-4" /> : <ChevronRight className="ml-auto h-4 w-4" />}
            </button>
            {settingsOpen && (
              <div className="mt-1 space-y-1 pl-3">
                {visibleSettings.map((item) => (
                  <NavButton key={item.key} item={item} active={activeView === item.key} onClick={() => onNavigate(item.key)} />
                ))}
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Usuário */}
      {user && (
        <div className="border-t border-sidebar-border p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">{initial}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{user.name}</span>
                  <span className="block truncate text-[10px] text-sidebar-foreground/60">{ROLE_LABELS[user.role || ''] || user.role}</span>
                </span>
                <ChevronsUpDown className="h-4 w-4 shrink-0 text-sidebar-foreground/60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-52">
              <DropdownMenuItem onClick={onOpenMeusDados}><Settings className="h-4 w-4" /> Meus dados</DropdownMenuItem>
              {onOpenServerConfig && <DropdownMenuItem onClick={onOpenServerConfig}><Server className="h-4 w-4" /> Servidor QuePasa</DropdownMenuItem>}
              <DropdownMenuItem onClick={() => setTheme(toggleTheme())}>
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} Tema: {theme === 'dark' ? 'claro' : 'escuro'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onLogout}><LogOut className="h-4 w-4" /> Sair</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
