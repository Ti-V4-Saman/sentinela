import React, { useState, useRef, useEffect } from 'react';
import { Settings, Building2, Users, UsersRound, LogOut, ChevronDown } from 'lucide-react';

const ROLE_LABELS = { superadmin: 'Superadmin', admin: 'Administrador', gestor: 'Gestor', usuario: 'Usuário' };

// Itens de navegação por papel (terminologia visível: "Clientes").
const NAV_BY_ROLE = {
  superadmin: [{ key: 'tenants', label: 'Clientes', icon: Building2 }],
  admin: [
    { key: 'users', label: 'Usuários', icon: Users },
    { key: 'teams', label: 'Equipes', icon: UsersRound },
  ],
  gestor: [],
  usuario: [],
};

function Item({ icon: Icon, label, onClick, danger }) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
        danger ? 'text-rose-400 hover:bg-rose-950/50' : 'text-slate-200 hover:bg-dark-hover'
      }`}>
      <Icon className="w-4 h-4 shrink-0" />{label}
    </button>
  );
}

export default function UserMenu({ user, onOpenMeusDados, setActiveView, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!user) return null;
  const navItems = NAV_BY_ROLE[user.role] || [];
  const initial = (user.name || 'U').charAt(0).toUpperCase();
  const go = (key) => { setActiveView(key); setOpen(false); };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-lg hover:bg-dark-hover transition-colors">
        <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-brand-emeraldDark to-brand-emerald text-black font-bold text-sm flex items-center justify-center">{initial}</div>
        <div className="hidden sm:block text-right leading-tight">
          <div className="text-xs font-semibold text-slate-200">{user.name}</div>
          <div className="text-[10px] text-slate-400">{ROLE_LABELS[user.role] || user.role}</div>
        </div>
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-56 bg-dark-card border border-dark-border rounded-xl shadow-2xl py-1.5 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
          <Item icon={Settings} label="Meus dados" onClick={() => { onOpenMeusDados(); setOpen(false); }} />
          {navItems.length > 0 && <div className="my-1.5 border-t border-dark-border/70" />}
          {navItems.map((i) => <Item key={i.key} icon={i.icon} label={i.label} onClick={() => go(i.key)} />)}
          <div className="my-1.5 border-t border-dark-border/70" />
          <Item icon={LogOut} label="Sair" danger onClick={onLogout} />
        </div>
      )}
    </div>
  );
}
