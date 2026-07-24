import React from 'react';
import {
  Search,
  Plus,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  LogOut
} from 'lucide-react';

const ROLE_LABELS = {
  superadmin: 'Superadmin',
  admin: 'Administrador',
  gestor: 'Gestor',
  usuario: 'Usuário',
};

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
  onLogout
}) {
  return (
    <header className="sticky top-0 z-30 bg-dark-bg/95 backdrop-blur border-b border-dark-border px-4 lg:px-8 py-4">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        
        {/* Logo & Subtitle */}
        <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-start">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-brand-emeraldDark to-brand-emerald flex items-center justify-center text-black font-bold shadow-lg shadow-brand-emerald/20">
              <ShieldCheck className="w-6 h-6 text-black" />
            </div>
            <div>
              <h1 className="text-xl font-bold font-outfit text-white tracking-wide">
                Sentinela
              </h1>
              <p className="text-xs text-slate-400">
                Painel de Conexões WhatsApp
              </p>
            </div>
          </div>
        </div>

        {/* Center Search & Filters */}
        <div className="flex items-center gap-3 w-full md:w-auto flex-1 max-w-xl">
          {/* Search Box */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Pesquisar por nome ou número..."
              className="w-full pl-9 pr-4 py-2 text-sm bg-dark-input border border-dark-border rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-brand-emerald focus:ring-1 focus:ring-brand-emerald transition-all"
            />
          </div>

          {/* Status Filter */}
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
        </div>

        {/* Action Controls right */}
        <div className="flex items-center gap-2.5 w-full md:w-auto justify-end">
          
          {/* Refresh Button */}
          <button
            onClick={onRefresh}
            title="Atualizar status"
            className="p-2 bg-dark-card hover:bg-dark-hover border border-dark-border rounded-lg text-slate-300 transition-all hover:text-white"
          >
            <RotateCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-brand-emerald' : ''}`} />
          </button>

          {/* Criar instância — só admin/superadmin */}
          {isAdmin && (
            <button
              onClick={onOpenCreateModal}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg transition-all shadow-md shadow-brand-emerald/20 hover:shadow-brand-emerald/40 active:scale-95"
            >
              <Plus className="w-4 h-4 stroke-[3]" />
              <span>Instance +</span>
            </button>
          )}

          {/* Usuário logado + logout */}
          {user && (
            <div className="flex items-center gap-2 pl-2.5 ml-0.5 border-l border-dark-border">
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

      </div>
    </header>
  );
}
