import React from 'react';
import {
  Search,
  Plus,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  LogOut,
  Radio,
  Building2,
  Users,
  UsersRound
} from 'lucide-react';

const ROLE_LABELS = {
  superadmin: 'Superadmin',
  admin: 'Administrador',
  gestor: 'Gestor',
  usuario: 'Usuário',
};

// Itens de navegação por papel.
const NAV_ITEMS = [
  { key: 'instances', label: 'Instâncias', icon: Radio, roles: ['superadmin', 'admin', 'gestor', 'usuario'] },
  { key: 'tenants', label: 'Tenants', icon: Building2, roles: ['superadmin'] },
  { key: 'users', label: 'Usuários', icon: Users, roles: ['superadmin', 'admin'] },
  { key: 'teams', label: 'Equipes', icon: UsersRound, roles: ['superadmin', 'admin'] },
];

export default function Header({
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  onRefresh,
  isRefreshing,
  onOpenCreateModal,
  isAdmin = false,
  user = null,
  onLogout,
  activeView = 'instances',
  setActiveView
}) {
  const role = user?.role;
  const navItems = NAV_ITEMS.filter((i) => i.roles.includes(role));

  return (
    <header className="sticky top-0 z-30 bg-dark-bg/95 backdrop-blur border-b border-dark-border px-4 lg:px-8">
      {/* Linha 1: logo + navegação + usuário */}
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 py-3">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-emeraldDark to-brand-emerald flex items-center justify-center text-black font-bold shadow-lg shadow-brand-emerald/20">
            <ShieldCheck className="w-5 h-5 text-black" />
          </div>
          <h1 className="text-lg font-bold font-outfit text-white tracking-wide hidden sm:block">Sentinela</h1>
        </div>

        {/* Navegação por papel */}
        <nav className="flex items-center gap-1 flex-1 overflow-x-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeView === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setActiveView?.(item.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg whitespace-nowrap transition-all ${
                  active
                    ? 'bg-brand-emerald/15 text-brand-emerald border border-brand-emerald/30'
                    : 'text-slate-400 hover:text-white hover:bg-dark-hover border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </button>
            );
          })}
        </nav>

        {user && (
          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden sm:block text-right leading-tight">
              <div className="text-xs font-semibold text-slate-200">{user.name}</div>
              <div className="text-[10px] text-slate-400">{ROLE_LABELS[user.role] || user.role}</div>
            </div>
            <button
              onClick={onLogout}
              title="Sair"
              className="p-2 bg-dark-card hover:bg-rose-950 border border-dark-border hover:border-rose-800 rounded-lg text-slate-300 hover:text-rose-300 transition-all"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Linha 2: controles da view de instâncias (só quando ativa) */}
      {activeView === 'instances' && (
        <div className="max-w-7xl mx-auto flex items-center gap-3 pb-3">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Pesquisar por nome ou número..."
              className="w-full pl-9 pr-4 py-2 text-sm bg-dark-input border border-dark-border rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-emerald focus:ring-1 focus:ring-brand-emerald transition-all"
            />
          </div>

          <div className="relative min-w-[130px]">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full pl-3 pr-8 py-2 text-sm bg-dark-input border border-dark-border rounded-lg text-slate-200 focus:outline-none focus:border-brand-emerald appearance-none cursor-pointer"
            >
              <option value="ALL">Status: Todos</option>
              <option value="Connected">Conectados</option>
              <option value="Disconnected">Desconectados</option>
            </select>
            <SlidersHorizontal className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
          </div>

          <button
            onClick={onRefresh}
            title="Atualizar status"
            className="p-2 bg-dark-card hover:bg-dark-hover border border-dark-border rounded-lg text-slate-300 transition-all hover:text-white"
          >
            <RotateCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-brand-emerald' : ''}`} />
          </button>

          {isAdmin && (
            <button
              onClick={onOpenCreateModal}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg transition-all shadow-md shadow-brand-emerald/20 active:scale-95 ml-auto"
            >
              <Plus className="w-4 h-4 stroke-[3]" />
              <span>Instance +</span>
            </button>
          )}
        </div>
      )}
    </header>
  );
}
