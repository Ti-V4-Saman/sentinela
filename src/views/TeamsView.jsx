import React, { useEffect, useState } from 'react';
import { UsersRound, Plus, Pencil, Trash2, Loader2, AlertCircle, X, Radio, UserCog, User, Link2, Unlink, Info } from 'lucide-react';
import {
  listTeams, createTeam, updateTeam, deleteTeam,
  listTeamInstances, listTeamUsers, linkTeamUser, unlinkTeamUser,
  listTeamManagers, linkTeamManager, unlinkTeamManager,
  listTenants, listUsers,
} from '../services/adminApi';
import { getUser } from '../services/authApi';
import { useToast } from '../components/ui/ToastProvider';
import { useConfirm } from '../components/ui/ConfirmProvider';
import { friendlyError } from '../utils/validation';

const Req = () => <span className="text-rose-400">*</span>;

function TeamModal({ initial, isSuper, tenants, onClose, onSaved, toast }) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [tenantId, setTenantId] = useState(initial?.tenantId || '');
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const validate = () => {
    const e = {};
    if (!name.trim()) e.name = 'Campo obrigatório';
    if (isSuper && !editing && !tenantId) e.tenantId = 'Selecione um cliente';
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      if (editing) { await updateTeam(initial.id, { name }); toast.success('Equipe atualizada', `"${name}" foi salva.`); }
      else { await createTeam(isSuper ? { name, tenantId: Number(tenantId) } : { name }); toast.success('Equipe criada', `"${name}" foi adicionada.`); }
      onSaved();
    } catch (err) { toast.error('Não foi possível salvar', friendlyError(err.message)); }
    finally { setSaving(false); }
  };
  const cls = (err) => `w-full bg-dark-input border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none ${err ? 'border-rose-600' : 'border-dark-border focus:border-brand-emerald/60'}`;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md bg-dark-card border border-dark-border rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold font-outfit text-white">{editing ? 'Editar Equipe' : 'Nova Equipe'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Nome da equipe <Req /></label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={validate} className={cls(errors.name)} />
            {errors.name && <p className="text-[11px] text-rose-400 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{errors.name}</p>}
          </div>
          {isSuper && !editing && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Cliente <Req /></label>
              <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} onBlur={validate} className={cls(errors.tenantId)}>
                <option value="">Selecione…</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              {errors.tenantId && <p className="text-[11px] text-rose-400 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{errors.tenantId}</p>}
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

function TeamLinksModal({ team, isSuper, onClose, toast }) {
  const [derived, setDerived] = useState([]);      // números derivados (read-only)
  const [members, setMembers] = useState([]);       // usuários-membros (team_users)
  const [managers, setManagers] = useState([]);     // gestores (team_managers)
  const [availMembers, setAvailMembers] = useState([]);
  const [availGestores, setAvailGestores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [memberToAdd, setMemberToAdd] = useState('');
  const [mgrToAdd, setMgrToAdd] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [di, tu, tm, allUsers] = await Promise.all([
        listTeamInstances(team.id), listTeamUsers(team.id), listTeamManagers(team.id),
        listUsers(isSuper ? team.tenantId : undefined),
      ]);
      setDerived(di); setMembers(tu); setManagers(tm);
      const memberIds = new Set(tu.map((u) => u.id));
      setAvailMembers(allUsers.filter((u) => u.role === 'usuario' && Number(u.tenantId) === Number(team.tenantId) && !memberIds.has(u.id)));
      const mgrIds = new Set(tm.map((m) => m.id));
      setAvailGestores(allUsers.filter((u) => u.role === 'gestor' && Number(u.tenantId) === Number(team.tenantId) && !mgrIds.has(u.id)));
    } catch (e) { toast.error('Erro ao carregar vínculos', friendlyError(e.message)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const addMember = async () => { if (!memberToAdd) return; try { await linkTeamUser(team.id, memberToAdd); setMemberToAdd(''); load(); toast.success('Usuário vinculado', 'Membro adicionado; os números dele entram na equipe.'); } catch (e) { toast.error('Não foi possível vincular', friendlyError(e.message)); } };
  const removeMember = async (id) => { try { await unlinkTeamUser(team.id, id); load(); toast.success('Usuário desvinculado', 'Membro removido; os números dele saem da equipe.'); } catch (e) { toast.error('Não foi possível desvincular', friendlyError(e.message)); } };
  const addManager = async () => { if (!mgrToAdd) return; try { await linkTeamManager(team.id, mgrToAdd); setMgrToAdd(''); load(); toast.success('Gestor vinculado', 'Gestor adicionado à equipe.'); } catch (e) { toast.error('Não foi possível vincular', friendlyError(e.message)); } };
  const removeManager = async (id) => { try { await unlinkTeamManager(team.id, id); load(); toast.success('Gestor desvinculado', 'Gestor removido da equipe.'); } catch (e) { toast.error('Não foi possível desvincular', friendlyError(e.message)); } };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-lg bg-dark-card border border-dark-border rounded-2xl p-6 my-auto">
        <div className="flex items-center justify-between mb-4">
          <div><h3 className="text-base font-bold font-outfit text-white">Equipe: {team.name}</h3><p className="text-xs text-slate-400">Membros, números derivados e gestores</p></div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : (
          <div className="space-y-6">
            {/* Números derivados (read-only) */}
            <section>
              <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-200 mb-1"><Radio className="w-4 h-4 text-brand-emerald" /> Números vinculados</h4>
              <p className="flex items-center gap-1.5 text-[11px] text-slate-500 mb-2"><Info className="w-3 h-3" /> Automático — vem dos usuários vinculados abaixo.</p>
              <div className="space-y-1.5">
                {derived.length === 0 && <p className="text-xs text-slate-500">Nenhum número — vincule usuários abaixo.</p>}
                {derived.map((i) => (
                  <div key={i.id} className="flex items-center justify-between bg-dark-input/60 border border-dark-border rounded-lg px-3 py-2">
                    <span className="text-sm text-slate-300">{i.name}</span>
                    <span className="text-[11px] text-slate-500">dono: {i.ownerName}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Usuários-membros */}
            <section>
              <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-200 mb-2"><User className="w-4 h-4 text-brand-emerald" /> Usuários vinculados</h4>
              <div className="space-y-1.5 mb-3">
                {members.length === 0 && <p className="text-xs text-slate-500">Nenhum usuário vinculado.</p>}
                {members.map((m) => (
                  <div key={m.id} className="flex items-center justify-between bg-dark-input border border-dark-border rounded-lg px-3 py-2">
                    <span className="text-sm text-slate-200">{m.name} <span className="text-xs text-slate-500 font-mono">{m.email}</span></span>
                    <button onClick={() => removeMember(m.id)} title="Desvincular" className="text-slate-400 hover:text-rose-400"><Unlink className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <select value={memberToAdd} onChange={(e) => setMemberToAdd(e.target.value)} className="flex-1 bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60">
                  <option value="">Adicionar usuário…</option>
                  {availMembers.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                </select>
                <button onClick={addMember} disabled={!memberToAdd} className="flex items-center gap-1 px-3 py-2 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg disabled:opacity-50"><Link2 className="w-4 h-4" /></button>
              </div>
              {availMembers.length === 0 && members.length === 0 && (
                <p className="text-[11px] text-slate-500 mt-2">Sem usuários (papel "usuário") neste cliente. Crie-os na tela de Usuários.</p>
              )}
            </section>

            {/* Gestores (inalterado) */}
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
                <select value={mgrToAdd} onChange={(e) => setMgrToAdd(e.target.value)} className="flex-1 bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60">
                  <option value="">Adicionar gestor…</option>
                  {availGestores.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                </select>
                <button onClick={addManager} disabled={!mgrToAdd} className="flex items-center gap-1 px-3 py-2 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg disabled:opacity-50"><Link2 className="w-4 h-4" /></button>
              </div>
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
  const toast = useToast();
  const confirm = useConfirm();
  const [teams, setTeams] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editModal, setEditModal] = useState(null);
  const [linksTeam, setLinksTeam] = useState(null);

  const tenantName = (id) => tenants.find((t) => t.id === id)?.name || `#${id}`;

  const load = async () => {
    setLoading(true);
    try {
      if (isSuper && tenants.length === 0) setTenants(await listTenants());
      setTeams(await listTeams());
    } catch (e) { toast.error('Erro ao carregar equipes', friendlyError(e.message)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const remove = async (t) => {
    const ok = await confirm({
      title: `Excluir equipe "${t.name}"?`,
      description: 'Esta ação é irreversível.',
      impact: ['Os usuários e gestores vinculados NÃO são excluídos — apenas ficam sem equipe. As instâncias também permanecem (continuam com seus donos).'],
      variant: 'danger',
      confirmLabel: 'Excluir permanentemente',
    });
    if (!ok) return;
    try { await deleteTeam(t.id); load(); toast.success('Equipe excluída', `"${t.name}" foi removida.`); }
    catch (e) { toast.error('Não foi possível excluir', friendlyError(e.message)); }
  };

  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-8">
      <div className="flex items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-emerald/10 border border-brand-emerald/30 flex items-center justify-center text-brand-emerald"><UsersRound className="w-5 h-5" /></div>
          <div><h2 className="text-2xl font-bold font-outfit text-white">Equipes</h2><p className="text-xs text-slate-400 mt-0.5">Agrupam usuários; os números vêm dos usuários</p></div>
        </div>
        <button onClick={() => setEditModal({})} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg shadow-md shadow-brand-emerald/20 active:scale-95">
          <Plus className="w-4 h-4 stroke-[3]" /> Nova Equipe
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : teams.length === 0 ? (
        <div className="bg-dark-card border border-dark-border rounded-2xl p-12 text-center">
          <UsersRound className="w-8 h-8 text-slate-500 mx-auto mb-3" />
          <h3 className="text-lg font-bold text-white mb-1">Nenhuma equipe</h3>
          <p className="text-xs text-slate-400 mb-6">Crie uma equipe e vincule usuários a ela.</p>
          <button onClick={() => setEditModal({})} className="px-5 py-2.5 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg">Nova Equipe</button>
        </div>
      ) : (
        <div className="bg-dark-card border border-dark-border rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-dark-border">
                  <th className="px-4 py-3 font-medium">Nome</th>
                  {isSuper && <th className="px-4 py-3 font-medium">Cliente</th>}
                  <th className="px-4 py-3 font-medium text-center">Usuários</th>
                  <th className="px-4 py-3 font-medium text-center">Gestores</th>
                  <th className="px-4 py-3 font-medium text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.id} className="border-b border-dark-border/50 last:border-0 hover:bg-dark-hover/40">
                    <td className="px-4 py-3 font-semibold text-white">{t.name}</td>
                    {isSuper && <td className="px-4 py-3 text-slate-400 text-xs">{tenantName(t.tenantId)}</td>}
                    <td className="px-4 py-3 text-center text-slate-300">{t.userCount}</td>
                    <td className="px-4 py-3 text-center text-slate-300">{t.managerCount}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => setLinksTeam(t)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-brand-emerald/15 hover:bg-brand-emerald/25 text-brand-emerald border border-brand-emerald/30 rounded-lg"><Link2 className="w-3.5 h-3.5" /> Vínculos</button>
                        <button onClick={() => setEditModal(t)} title="Renomear" className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-dark-hover"><Pencil className="w-4 h-4" /></button>
                        <button onClick={() => remove(t)} title="Excluir" className="p-1.5 rounded-md text-slate-400 hover:text-rose-400 hover:bg-rose-950/50"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editModal !== null && (
        <TeamModal initial={editModal.id ? editModal : null} isSuper={isSuper} tenants={tenants} toast={toast}
          onClose={() => setEditModal(null)} onSaved={() => { setEditModal(null); load(); }} />
      )}
      {linksTeam && <TeamLinksModal team={linksTeam} isSuper={isSuper} toast={toast} onClose={() => { setLinksTeam(null); load(); }} />}
    </main>
  );
}
