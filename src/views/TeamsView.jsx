import React, { useEffect, useState } from 'react';
import { UsersRound, Plus, Pencil, Trash2, Loader2, AlertCircle, X, Radio, UserCog, Link2, Unlink } from 'lucide-react';
import {
  listTeams, createTeam, updateTeam, deleteTeam,
  listTeamInstances, linkTeamInstance, unlinkTeamInstance,
  listTeamManagers, linkTeamManager, unlinkTeamManager,
  listTenants, listUsers,
} from '../services/adminApi';
import { fetchInstancesApi } from '../services/quepasaApi';
import { getUser } from '../services/authApi';

function TeamModal({ initial, isSuper, tenants, onClose, onSaved }) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [tenantId, setTenantId] = useState(initial?.tenantId || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      if (editing) await updateTeam(initial.id, { name });
      else await createTeam(isSuper ? { name, tenantId: Number(tenantId) } : { name });
      onSaved();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md bg-dark-card border border-dark-border rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold font-outfit text-white">{editing ? 'Editar Equipe' : 'Nova Equipe'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          {error && <div className="flex items-center gap-2 text-xs bg-rose-950 border border-rose-800 text-rose-200 rounded-lg px-3 py-2"><AlertCircle className="w-4 h-4 shrink-0" /><span>{error}</span></div>}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Nome da equipe</label>
            <input autoFocus required value={name} onChange={(e) => setName(e.target.value)}
              className="w-full bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60" />
          </div>
          {isSuper && !editing && (
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
            <button type="submit" disabled={saving} className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg disabled:opacity-60">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{editing ? 'Salvar' : 'Criar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TeamLinksModal({ team, isSuper, onClose }) {
  const [instances, setInstances] = useState([]);
  const [managers, setManagers] = useState([]);
  const [availInstances, setAvailInstances] = useState([]);
  const [availGestores, setAvailGestores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [instToAdd, setInstToAdd] = useState('');
  const [mgrToAdd, setMgrToAdd] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [ti, tm, allInst, allUsers] = await Promise.all([
        listTeamInstances(team.id),
        listTeamManagers(team.id),
        fetchInstancesApi(),
        listUsers(isSuper ? team.tenantId : undefined),
      ]);
      setInstances(ti); setManagers(tm);
      const linkedInst = new Set(ti.map((i) => i.id));
      setAvailInstances(allInst.filter((i) => Number(i.tenantId) === Number(team.tenantId) && !linkedInst.has(i.id)));
      const linkedMgr = new Set(tm.map((m) => m.id));
      setAvailGestores(allUsers.filter((u) => u.role === 'gestor' && Number(u.tenantId) === Number(team.tenantId) && !linkedMgr.has(u.id)));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const addInstance = async () => { if (!instToAdd) return; try { await linkTeamInstance(team.id, instToAdd); setInstToAdd(''); load(); } catch (e) { setError(e.message); } };
  const removeInstance = async (id) => { try { await unlinkTeamInstance(team.id, id); load(); } catch (e) { setError(e.message); } };
  const addManager = async () => { if (!mgrToAdd) return; try { await linkTeamManager(team.id, mgrToAdd); setMgrToAdd(''); load(); } catch (e) { setError(e.message); } };
  const removeManager = async (id) => { try { await unlinkTeamManager(team.id, id); load(); } catch (e) { setError(e.message); } };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-lg bg-dark-card border border-dark-border rounded-2xl p-6 my-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-bold font-outfit text-white">Equipe: {team.name}</h3>
            <p className="text-xs text-slate-400">Vincular números e gestores</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        {error && <div className="flex items-center gap-2 text-xs bg-rose-950 border border-rose-800 text-rose-200 rounded-lg px-3 py-2 mb-4"><AlertCircle className="w-4 h-4 shrink-0" /><span>{error}</span></div>}

        {loading ? (
          <div className="flex items-center justify-center py-12 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : (
          <div className="space-y-6">
            {/* Instâncias */}
            <section>
              <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-200 mb-2"><Radio className="w-4 h-4 text-brand-emerald" /> Números vinculados</h4>
              <div className="space-y-1.5 mb-3">
                {instances.length === 0 && <p className="text-xs text-slate-500">Nenhuma instância vinculada.</p>}
                {instances.map((i) => (
                  <div key={i.id} className="flex items-center justify-between bg-dark-input border border-dark-border rounded-lg px-3 py-2">
                    <span className="text-sm text-slate-200">{i.name}</span>
                    <button onClick={() => removeInstance(i.id)} title="Desvincular" className="text-slate-400 hover:text-rose-400"><Unlink className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <select value={instToAdd} onChange={(e) => setInstToAdd(e.target.value)}
                  className="flex-1 bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60">
                  <option value="">Adicionar instância…</option>
                  {availInstances.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
                <button onClick={addInstance} disabled={!instToAdd} className="flex items-center gap-1 px-3 py-2 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg disabled:opacity-50"><Link2 className="w-4 h-4" /></button>
              </div>
            </section>

            {/* Gestores */}
            <section>
              <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-200 mb-2"><UserCog className="w-4 h-4 text-brand-emerald" /> Gestores vinculados</h4>
              <div className="space-y-1.5 mb-3">
                {managers.length === 0 && <p className="text-xs text-slate-500">Nenhum gestor vinculado.</p>}
                {managers.map((m) => (
                  <div key={m.id} className="flex items-center justify-between bg-dark-input border border-dark-border rounded-lg px-3 py-2">
                    <span className="text-sm text-slate-200">{m.name} <span className="text-xs text-slate-500 font-mono">{m.email}</span></span>
                    <button onClick={() => removeManager(m.id)} title="Desvincular" className="text-slate-400 hover:text-rose-400"><Unlink className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <select value={mgrToAdd} onChange={(e) => setMgrToAdd(e.target.value)}
                  className="flex-1 bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60">
                  <option value="">Adicionar gestor…</option>
                  {availGestores.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                </select>
                <button onClick={addManager} disabled={!mgrToAdd} className="flex items-center gap-1 px-3 py-2 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg disabled:opacity-50"><Link2 className="w-4 h-4" /></button>
              </div>
              {availGestores.length === 0 && managers.length === 0 && (
                <p className="text-[11px] text-slate-500 mt-2">Sem gestores neste tenant. Crie usuários com papel "Gestor" na tela de Usuários.</p>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TeamsView() {
  const me = getUser();
  const isSuper = me?.role === 'superadmin';
  const [teams, setTeams] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editModal, setEditModal] = useState(null);
  const [linksTeam, setLinksTeam] = useState(null);

  const tenantName = (id) => tenants.find((t) => t.id === id)?.name || `#${id}`;

  const load = async () => {
    setLoading(true); setError('');
    try {
      if (isSuper && tenants.length === 0) setTenants(await listTenants());
      setTeams(await listTeams());
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const remove = async (t) => {
    if (!window.confirm(`Remover a equipe "${t.name}"? Os vínculos de instâncias e gestores serão removidos.`)) return;
    try { await deleteTeam(t.id); load(); } catch (e) { setError(e.message); }
  };

  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-8">
      <div className="flex items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-emerald/10 border border-brand-emerald/30 flex items-center justify-center text-brand-emerald">
            <UsersRound className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-2xl font-bold font-outfit text-white">Equipes</h2>
            <p className="text-xs text-slate-400 mt-0.5">Agrupam números e vinculam gestores</p>
          </div>
        </div>
        <button onClick={() => setEditModal({})}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg shadow-md shadow-brand-emerald/20 active:scale-95">
          <Plus className="w-4 h-4 stroke-[3]" /> Nova Equipe
        </button>
      </div>

      {error && <div className="flex items-center gap-2 text-sm bg-rose-950 border border-rose-800 text-rose-200 rounded-lg px-3 py-2 mb-4"><AlertCircle className="w-4 h-4 shrink-0" /><span>{error}</span></div>}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : teams.length === 0 ? (
        <div className="bg-dark-card border border-dark-border rounded-2xl p-12 text-center">
          <UsersRound className="w-8 h-8 text-slate-500 mx-auto mb-3" />
          <h3 className="text-lg font-bold text-white mb-1">Nenhuma equipe</h3>
          <p className="text-xs text-slate-400 mb-6">Crie uma equipe para agrupar números e vincular gestores.</p>
          <button onClick={() => setEditModal({})} className="px-5 py-2.5 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg">Nova Equipe</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {teams.map((t) => (
            <div key={t.id} className="bg-dark-card border border-dark-border rounded-xl p-4 flex flex-col justify-between">
              <div className="mb-3">
                <h3 className="font-bold font-outfit text-white">{t.name}</h3>
                {isSuper && <p className="text-[11px] text-slate-400 mt-0.5">{tenantName(t.tenantId)}</p>}
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setLinksTeam(t)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-brand-emerald/15 hover:bg-brand-emerald/25 text-brand-emerald border border-brand-emerald/30 rounded-lg">
                  <Link2 className="w-3.5 h-3.5" /> Vínculos
                </button>
                <button onClick={() => setEditModal(t)} title="Renomear" className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-dark-hover"><Pencil className="w-4 h-4" /></button>
                <button onClick={() => remove(t)} title="Excluir" className="p-1.5 rounded-md text-slate-400 hover:text-rose-400 hover:bg-rose-950/50"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editModal !== null && (
        <TeamModal initial={editModal.id ? editModal : null} isSuper={isSuper} tenants={tenants}
          onClose={() => setEditModal(null)} onSaved={() => { setEditModal(null); load(); }} />
      )}
      {linksTeam && <TeamLinksModal team={linksTeam} isSuper={isSuper} onClose={() => setLinksTeam(null)} />}
    </main>
  );
}
