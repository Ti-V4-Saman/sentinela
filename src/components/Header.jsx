import React from 'react';
import { Search, Plus, RotateCw, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import UserMenu from './UserMenu';
import { homeView } from '../utils/nav';

export default function Header({
  searchQuery,
  setSearchQuery,
  statusFilter,
  setStatusFilter,
  onRefresh,
  isRefreshing,
  onOpenCreateModal,
  canCreate = false,
  user = null,
  onLogout,
  onOpenMeusDados,
  activeView = 'instances',
  setActiveView
}) {
  return (
    <header className="sticky top-0 z-30 bg-dark-bg/95 backdrop-blur border-b border-dark-border px-4 lg:px-8">
      {/* Linha 1: logo (volta para instâncias) + menu do usuário */}
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 py-3">
        <button onClick={() => setActiveView?.(homeView(user?.role))} title="Ir para o início"
          className="flex items-center gap-2.5 shrink-0 group cursor-pointer">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-emeraldDark to-brand-emerald flex items-center justify-center text-black font-bold shadow-lg shadow-brand-emerald/20 group-hover:scale-105 transition-transform">
            <ShieldCheck className="w-5 h-5 text-black" />
          </div>
          <div className="text-left">
            <h1 className="text-lg font-bold font-outfit text-white tracking-wide leading-none group-hover:text-brand-emerald transition-colors">Sentinela</h1>
            <p className="text-[10px] text-slate-400 hidden sm:block">Monitoramento WhatsApp</p>
          </div>
        </button>

        <UserMenu
          user={user}
          onOpenMeusDados={onOpenMeusDados}
          setActiveView={setActiveView}
          onLogout={onLogout}
        />
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

          {canCreate && (
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
