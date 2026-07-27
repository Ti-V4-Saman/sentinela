import * as React from 'react';
import {
  ShieldCheck, Radio, Building2, Users, UsersRound,
  Settings, LogOut, Sun, Moon, ChevronsUpDown, Server,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { getTheme, toggleTheme, type Theme } from '@/utils/theme';

type Role = 'superadmin' | 'admin' | 'gestor' | 'usuario';
type NavKey = 'instances' | 'tenants' | 'users' | 'teams';

const ROLE_LABELS: Record<string, string> = {
  superadmin: 'Superadmin', admin: 'Administrador', gestor: 'Gestor', usuario: 'Usuário',
};

const NAV: { key: NavKey; label: string; icon: React.ComponentType<{ className?: string }>; roles: Role[] }[] = [
  { key: 'instances', label: 'Conexões', icon: Radio, roles: ['admin', 'gestor', 'usuario'] },
  { key: 'tenants', label: 'Clientes', icon: Building2, roles: ['superadmin'] },
  { key: 'users', label: 'Usuários', icon: Users, roles: ['superadmin', 'admin'] },
  { key: 'teams', label: 'Equipes', icon: UsersRound, roles: ['superadmin', 'admin'] },
];

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
  const items = NAV.filter((i) => user?.role && i.roles.includes(user.role as Role));
  const initial = (user?.name || 'U').charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-60 flex-col bg-sidebar text-sidebar-foreground">
      {/* Logo */}
      <button
        onClick={onHome}
        className="flex items-center gap-2.5 px-4 py-4 text-left transition-opacity hover:opacity-90"
        title="Início"
      >
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div>
          <p className="font-heading text-base font-semibold leading-none">Sentinela</p>
          <p className="text-[10px] text-sidebar-foreground/60">Monitoramento WhatsApp</p>
        </div>
      </button>

      {/* Navegação */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {items.map((item) => {
          const Icon = item.icon;
          const active = activeView === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Usuário */}
      {user && (
        <div className="border-t border-sidebar-border p-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/50">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
                  {initial}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{user.name}</span>
                  <span className="block truncate text-[10px] text-sidebar-foreground/60">
                    {ROLE_LABELS[user.role || ''] || user.role}
                  </span>
                </span>
                <ChevronsUpDown className="h-4 w-4 shrink-0 text-sidebar-foreground/60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-52">
              <DropdownMenuItem onClick={onOpenMeusDados}>
                <Settings className="h-4 w-4" /> Meus dados
              </DropdownMenuItem>
              {onOpenServerConfig && (
                <DropdownMenuItem onClick={onOpenServerConfig}>
                  <Server className="h-4 w-4" /> Servidor QuePasa
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setTheme(toggleTheme())}>
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                Tema: {theme === 'dark' ? 'claro' : 'escuro'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onLogout}>
                <LogOut className="h-4 w-4" /> Sair
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
