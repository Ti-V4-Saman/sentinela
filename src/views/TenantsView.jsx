import React, { useEffect, useState } from 'react';
import { Building2, Plus, Pencil, Trash2, Loader2, AlertCircle, X, CheckCircle2, PauseCircle, PlayCircle } from 'lucide-react';
import { listTenants, createTenant, updateTenant, deleteTenant } from '../services/adminApi';

function TenantModal({ initial, onClose, onSaved }) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [status, setStatus] = useState(initial?.status || 'active');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      const saved = editing
        ? await updateTenant(initial.id, { name, status })
        : await createTenant({ name });
      onSaved(saved);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md bg-dark-card border border-dark-border rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold font-outfit text-white">{editing ? 'Editar Tenant' : 'Novo Tenant'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 text-xs bg-rose-950 border border-rose-800 text-rose-200 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0" /><span>{error}</span>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Nome do tenant</label>
            <input
              autoFocus required value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Cliente ACME"
              className="w-full bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60"
            />
          </div>
          {editing && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Status</label>
              <select
                value={status} onChange={(e) => setStatus(e.target.value)}
                className="w-full bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60"
              >
                <option value="active">Ativo</option>
                <option value="suspended">Suspenso</option>
              </select>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white">Cancelar</button>
            <button type="submit" disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg disabled:opacity-60">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {editing ? 'Salvar' : 'Criar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function TenantsView() {
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // null | {} (novo) | tenant (editar)

  const load = async () => {
    setLoading(true); setError('');
    try { setTenants(await listTenants()); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const toggleStatus = async (t) => {
    const next = t.status === 'active' ? 'suspended' : 'active';
    try { await updateTenant(t.id, { status: next }); load(); }
    catch (e) { setError(e.message); }
  };

  const remove = async (t) => {
    if (!window.confirm(`Remover o tenant "${t.name}"? Isso apaga seus usuários e equipes. Instâncias vinculadas bloqueiam a remoção.`)) return;
    try { await deleteTenant(t.id); load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-8">
      <div className="flex items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-emerald/10 border border-brand-emerald/30 flex items-center justify-center text-brand-emerald">
            <Building2 className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-2xl font-bold font-outfit text-white">Tenants</h2>
            <p className="text-xs text-slate-400 mt-0.5">Clientes isolados do sistema</p>
          </div>
        </div>
        <button onClick={() => setModal({})}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg shadow-md shadow-brand-emerald/20 active:scale-95">
          <Plus className="w-4 h-4 stroke-[3]" /> Novo Tenant
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm bg-rose-950 border border-rose-800 text-rose-200 rounded-lg px-3 py-2 mb-4">
          <AlertCircle className="w-4 h-4 shrink-0" /><span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : tenants.length === 0 ? (
        <div className="bg-dark-card border border-dark-border rounded-2xl p-12 text-center">
          <Building2 className="w-8 h-8 text-slate-500 mx-auto mb-3" />
          <h3 className="text-lg font-bold text-white mb-1">Nenhum tenant ainda</h3>
          <p className="text-xs text-slate-400 mb-6">Crie o primeiro cliente para isolar dados por tenant.</p>
          <button onClick={() => setModal({})} className="px-5 py-2.5 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg">Novo Tenant</button>
        </div>
      ) : (
        <div className="bg-dark-card border border-dark-border rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-dark-border">
                  <th className="px-4 py-3 font-medium">ID</th>
                  <th className="px-4 py-3 font-medium">Nome</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id} className="border-b border-dark-border/50 last:border-0 hover:bg-dark-hover/40">
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">#{t.id}</td>
                    <td className="px-4 py-3 font-semibold text-white">{t.name}</td>
                    <td className="px-4 py-3">
                      {t.status === 'active' ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-brand-emerald/15 text-brand-emerald border border-brand-emerald/30">
                          <CheckCircle2 className="w-3 h-3" /> Ativo
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-950 text-amber-300 border border-amber-800">
                          <PauseCircle className="w-3 h-3" /> Suspenso
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => toggleStatus(t)} title={t.status === 'active' ? 'Suspender' : 'Ativar'}
                          className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-dark-hover">
                          {t.status === 'active' ? <PauseCircle className="w-4 h-4" /> : <PlayCircle className="w-4 h-4" />}
                        </button>
                        <button onClick={() => setModal(t)} title="Editar"
                          className="p-1.5 rounded-md text-slate-400 hover:text-brand-emerald hover:bg-dark-hover">
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button onClick={() => remove(t)} title="Excluir"
                          className="p-1.5 rounded-md text-slate-400 hover:text-rose-400 hover:bg-rose-950/50">
                          <Trash2 className="w-4 h-4" />
                        </button>
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
        <TenantModal
          initial={modal.id ? modal : null}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
    </main>
  );
}
