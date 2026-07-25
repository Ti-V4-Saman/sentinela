import React, { useEffect, useState } from 'react';
import { Users, Plus, Pencil, Trash2, Loader2, AlertCircle, X, Ban, CheckCircle2 } from 'lucide-react';
import { listUsers, createUser, updateUser, deleteUser, listTenants } from '../services/adminApi';
import { getUser } from '../services/authApi';

const ROLE_LABELS = { superadmin: 'Superadmin', admin: 'Administrador', gestor: 'Gestor', usuario: 'Usuário' };
const ROLE_BADGE = {
  superadmin: 'bg-purple-950 text-purple-300 border-purple-800',
  admin: 'bg-sky-950 text-sky-300 border-sky-800',
  gestor: 'bg-amber-950 text-amber-300 border-amber-800',
  usuario: 'bg-slate-800 text-slate-300 border-slate-700',
};

function UserModal({ initial, isSuper, tenants, defaultTenantId, onClose, onSaved }) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [email, setEmail] = useState(initial?.email || '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(initial?.role || 'usuario');
  const [status, setStatus] = useState(initial?.status || 'active');
  const [tenantId, setTenantId] = useState(initial?.tenantId ?? defaultTenantId ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const roleOptions = isSuper ? ['superadmin', 'admin', 'gestor', 'usuario'] : ['admin', 'gestor', 'usuario'];
  const needsTenant = isSuper && role !== 'superadmin';

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      if (editing) {
        const body = { name, email, role, status };
        if (password) body.password = password;
        await updateUser(initial.id, body);
      } else {
        const body = { name, email, password, role };
        if (needsTenant) body.tenantId = Number(tenantId);
        await createUser(body);
      }
      onSaved();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md bg-dark-card border border-dark-border rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold font-outfit text-white">{editing ? 'Editar Usuário' : 'Novo Usuário'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={submit} className="space-y-3.5">
          {error && (
            <div className="flex items-center gap-2 text-xs bg-rose-950 border border-rose-800 text-rose-200 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0" /><span>{error}</span>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Nome</label>
            <input autoFocus required value={name} onChange={(e) => setName(e.target.value)}
              className="w-full bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">E-mail</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Senha {editing && <span className="text-slate-500">(deixe em branco para manter)</span>}
            </label>
            <input type="password" required={!editing} value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Papel</label>
              <select value={role} onChange={(e) => setRole(e.target.value)}
                className="w-full bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60">
                {roleOptions.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            {editing && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">Status</label>
                <select value={status} onChange={(e) => setStatus(e.target.value)}
                  className="w-full bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60">
                  <option value="active">Ativo</option>
                  <option value="disabled">Desativado</option>
                </select>
              </div>
            )}
          </div>
          {needsTenant && !editing && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Tenant</label>
              <select required value={tenantId} onChange={(e) => setTenantId(e.target.value)}
                className="w-full bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60">
                <option value="">Selecione…</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white">Cancelar</button>
            <button type="submit" disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg disabled:opacity-60">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{editing ? 'Salvar' : 'Criar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function UsersView() {
  const me = getUser();
  const isSuper = me?.role === 'superadmin';
  const [users, setUsers] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [tenantFilter, setTenantFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);

  const tenantName = (id) => tenants.find((t) => t.id === id)?.name || (id ? `#${id}` : '—');

  const load = async () => {
    setLoading(true); setError('');
    try {
      if (isSuper && tenants.length === 0) setTenants(await listTenants());
      setUsers(await listUsers(isSuper && tenantFilter ? tenantFilter : undefined));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenantFilter]);

  const remove = async (u) => {
    if (!window.confirm(`Remover o usuário "${u.name}" (${u.email})?`)) return;
    try { await deleteUser(u.id); load(); } catch (e) { setError(e.message); }
  };

  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-emerald/10 border border-brand-emerald/30 flex items-center justify-center text-brand-emerald">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-2xl font-bold font-outfit text-white">Usuários</h2>
            <p className="text-xs text-slate-400 mt-0.5">{isSuper ? 'Todos os tenants' : 'Do seu tenant'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isSuper && (
            <select value={tenantFilter} onChange={(e) => setTenantFilter(e.target.value)}
              className="bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-brand-emerald">
              <option value="">Todos os tenants</option>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <button onClick={() => setModal({})}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg shadow-md shadow-brand-emerald/20 active:scale-95">
            <Plus className="w-4 h-4 stroke-[3]" /> Novo Usuário
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm bg-rose-950 border border-rose-800 text-rose-200 rounded-lg px-3 py-2 mb-4">
          <AlertCircle className="w-4 h-4 shrink-0" /><span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : users.length === 0 ? (
        <div className="bg-dark-card border border-dark-border rounded-2xl p-12 text-center">
          <Users className="w-8 h-8 text-slate-500 mx-auto mb-3" />
          <h3 className="text-lg font-bold text-white mb-1">Nenhum usuário</h3>
          <p className="text-xs text-slate-400 mb-6">Crie o primeiro usuário{isSuper ? '' : ' do seu tenant'}.</p>
          <button onClick={() => setModal({})} className="px-5 py-2.5 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg">Novo Usuário</button>
        </div>
      ) : (
        <div className="bg-dark-card border border-dark-border rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-dark-border">
                  <th className="px-4 py-3 font-medium">Nome</th>
                  <th className="px-4 py-3 font-medium">E-mail</th>
                  <th className="px-4 py-3 font-medium">Papel</th>
                  {isSuper && <th className="px-4 py-3 font-medium">Tenant</th>}
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-dark-border/50 last:border-0 hover:bg-dark-hover/40">
                    <td className="px-4 py-3 font-semibold text-white">{u.name}</td>
                    <td className="px-4 py-3 text-slate-300 font-mono text-xs">{u.email}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold border ${ROLE_BADGE[u.role]}`}>{ROLE_LABELS[u.role]}</span>
                    </td>
                    {isSuper && <td className="px-4 py-3 text-slate-400 text-xs">{u.tenantId ? tenantName(u.tenantId) : '—'}</td>}
                    <td className="px-4 py-3">
                      {u.status === 'active'
                        ? <span className="inline-flex items-center gap-1 text-xs text-brand-emerald"><CheckCircle2 className="w-3.5 h-3.5" />Ativo</span>
                        : <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Ban className="w-3.5 h-3.5" />Desativado</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => setModal(u)} title="Editar" className="p-1.5 rounded-md text-slate-400 hover:text-brand-emerald hover:bg-dark-hover"><Pencil className="w-4 h-4" /></button>
                        {u.id !== me?.id && (
                          <button onClick={() => remove(u)} title="Excluir" className="p-1.5 rounded-md text-slate-400 hover:text-rose-400 hover:bg-rose-950/50"><Trash2 className="w-4 h-4" /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal !== null && (
        <UserModal
          initial={modal.id ? modal : null}
          isSuper={isSuper}
          tenants={tenants}
          defaultTenantId={isSuper ? '' : me?.tenantId}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
    </main>
  );
}
