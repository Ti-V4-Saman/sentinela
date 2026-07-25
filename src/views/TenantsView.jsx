import React, { useEffect, useState } from 'react';
import { Building2, Plus, Pencil, Trash2, Loader2, AlertCircle, X, CheckCircle2, PauseCircle, PlayCircle } from 'lucide-react';
import { listTenants, createTenant, updateTenant, deleteTenant, listUsers, listTeams } from '../services/adminApi';
import { fetchInstancesApi } from '../services/quepasaApi';
import { useToast } from '../components/ui/ToastProvider';
import { useConfirm } from '../components/ui/ConfirmProvider';
import { friendlyError } from '../utils/validation';

const Req = () => <span className="text-rose-400">*</span>;

function ClienteModal({ initial, onClose, onSaved, toast }) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [status, setStatus] = useState(initial?.status || 'active');
  const [nameErr, setNameErr] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setNameErr('Campo obrigatório'); return; }
    setSaving(true);
    try {
      const saved = editing ? await updateTenant(initial.id, { name, status }) : await createTenant({ name });
      onSaved();
      toast.success(editing ? 'Cliente atualizado' : 'Cliente criado', `"${saved.name}" foi ${editing ? 'salvo' : 'adicionado'} com sucesso.`);
    } catch (err) {
      toast.error('Não foi possível salvar', friendlyError(err.message));
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md bg-dark-card border border-dark-border rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold font-outfit text-white">{editing ? 'Editar Cliente' : 'Novo Cliente'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Nome do cliente <Req /></label>
            <input autoFocus value={name} onChange={(e) => { setName(e.target.value); if (nameErr) setNameErr(''); }}
              onBlur={() => setNameErr(name.trim() ? '' : 'Campo obrigatório')}
              placeholder="Ex.: Clínica Vitalis"
              className={`w-full bg-dark-input border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none ${nameErr ? 'border-rose-600' : 'border-dark-border focus:border-brand-emerald/60'}`} />
            {nameErr && <p className="text-[11px] text-rose-400 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{nameErr}</p>}
          </div>
          {editing && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)}
                className="w-full bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60">
                <option value="active">Ativo</option>
                <option value="suspended">Suspenso</option>
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

export default function TenantsView() {
  const toast = useToast();
  const confirm = useConfirm();
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);

  const load = async () => {
    setLoading(true);
    try { setTenants(await listTenants()); }
    catch (e) { toast.error('Erro ao carregar clientes', friendlyError(e.message)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const toggleStatus = async (t) => {
    if (t.status === 'active') {
      const ok = await confirm({
        title: `Suspender o cliente "${t.name}"?`,
        description: 'Ação reversível — você pode reativar depois.',
        impact: ['Usuários deste cliente não conseguem mais fazer login enquanto estiver suspenso.'],
        variant: 'warning',
        confirmLabel: 'Desativar',
      });
      if (!ok) return;
    }
    try {
      await updateTenant(t.id, { status: t.status === 'active' ? 'suspended' : 'active' });
      load();
      toast.success(t.status === 'active' ? 'Cliente suspenso' : 'Cliente reativado', `"${t.name}" foi atualizado.`);
    } catch (e) { toast.error('Não foi possível alterar', friendlyError(e.message)); }
  };

  const remove = async (t) => {
    // Levanta o impacto em cascata.
    let users = 0, teams = 0, instances = 0;
    try {
      const [u, tm, inst] = await Promise.all([listUsers(t.id), listTeams(t.id), fetchInstancesApi()]);
      users = u.length; teams = tm.length;
      instances = inst.filter((i) => Number(i.tenantId) === Number(t.id)).length;
    } catch { /* segue mesmo sem os counts */ }

    const impact = [
      `${users} usuário(s) vinculado(s) serão excluídos.`,
      `${teams} equipe(s) serão excluídas.`,
      instances > 0
        ? `${instances} instância(s) vinculada(s) IMPEDEM a exclusão — remova-as antes.`
        : 'Nenhuma instância vinculada.',
      'Todo o histórico de mensagens associado será perdido.',
    ];

    const ok = await confirm({
      title: `Excluir cliente "${t.name}"?`,
      description: 'Esta é a ação mais destrutiva do sistema e é irreversível.',
      impact,
      variant: 'danger',
      requireTypedName: t.name,
      confirmLabel: 'Excluir permanentemente',
    });
    if (!ok) return;
    try {
      await deleteTenant(t.id); load();
      toast.success('Cliente excluído', `"${t.name}" foi removido.`);
    } catch (e) { toast.error('Não foi possível excluir', friendlyError(e.message)); }
  };

  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-8">
      <div className="flex items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-emerald/10 border border-brand-emerald/30 flex items-center justify-center text-brand-emerald"><Building2 className="w-5 h-5" /></div>
          <div>
            <h2 className="text-2xl font-bold font-outfit text-white">Clientes</h2>
            <p className="text-xs text-slate-400 mt-0.5">Clientes isolados do sistema</p>
          </div>
        </div>
        <button onClick={() => setModal({})} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg shadow-md shadow-brand-emerald/20 active:scale-95">
          <Plus className="w-4 h-4 stroke-[3]" /> Novo Cliente
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : tenants.length === 0 ? (
        <div className="bg-dark-card border border-dark-border rounded-2xl p-12 text-center">
          <Building2 className="w-8 h-8 text-slate-500 mx-auto mb-3" />
          <h3 className="text-lg font-bold text-white mb-1">Nenhum cliente ainda</h3>
          <p className="text-xs text-slate-400 mb-6">Crie o primeiro cliente para isolar dados.</p>
          <button onClick={() => setModal({})} className="px-5 py-2.5 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg">Novo Cliente</button>
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
                      {t.status === 'active'
                        ? <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-brand-emerald/15 text-brand-emerald border border-brand-emerald/30"><CheckCircle2 className="w-3 h-3" /> Ativo</span>
                        : <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-950 text-amber-300 border border-amber-800"><PauseCircle className="w-3 h-3" /> Suspenso</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => toggleStatus(t)} title={t.status === 'active' ? 'Suspender' : 'Ativar'} className="p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-dark-hover">
                          {t.status === 'active' ? <PauseCircle className="w-4 h-4" /> : <PlayCircle className="w-4 h-4" />}
                        </button>
                        <button onClick={() => setModal(t)} title="Editar" className="p-1.5 rounded-md text-slate-400 hover:text-brand-emerald hover:bg-dark-hover"><Pencil className="w-4 h-4" /></button>
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

      {modal !== null && (
        <ClienteModal initial={modal.id ? modal : null} toast={toast} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </main>
  );
}
