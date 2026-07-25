import React, { useEffect, useState } from 'react';
import { Users, Plus, Pencil, Trash2, Loader2, AlertCircle, X, Ban, CheckCircle2 } from 'lucide-react';
import { listUsers, createUser, updateUser, deleteUser, listTenants } from '../services/adminApi';
import { getUser } from '../services/authApi';
import { useToast } from '../components/ui/ToastProvider';
import { useConfirm } from '../components/ui/ConfirmProvider';
import { validateFullName, validateEmail, friendlyError } from '../utils/validation';

const ROLE_LABELS = { superadmin: 'Superadmin', admin: 'Administrador', gestor: 'Gestor', usuario: 'Usuário' };
const ROLE_BADGE = {
  superadmin: 'bg-purple-950 text-purple-300 border-purple-800',
  admin: 'bg-sky-950 text-sky-300 border-sky-800',
  gestor: 'bg-amber-950 text-amber-300 border-amber-800',
  usuario: 'bg-slate-800 text-slate-300 border-slate-700',
};
const Req = () => <span className="text-rose-400">*</span>;

function UserModal({ initial, isSuper, tenants, defaultTenantId, onClose, onSaved, toast, confirm }) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [email, setEmail] = useState(initial?.email || '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(initial?.role || 'usuario');
  const [status, setStatus] = useState(initial?.status || 'active');
  const [tenantId, setTenantId] = useState(initial?.tenantId ?? defaultTenantId ?? '');
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const roleOptions = isSuper ? ['superadmin', 'admin', 'gestor', 'usuario'] : ['admin', 'gestor', 'usuario'];
  const needsTenant = isSuper && role !== 'superadmin';

  const validate = () => {
    const e = {};
    const nErr = validateFullName(name); if (nErr) e.name = nErr;
    const eErr = validateEmail(email); if (eErr) e.email = eErr;
    if (!editing && !password) e.password = 'Campo obrigatório';
    else if (password && password.length < 8) e.password = 'A senha precisa ter no mínimo 8 caracteres';
    if (needsTenant && !tenantId) e.tenantId = 'Selecione um cliente';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    // Mudança de papel é sensível: confirmar nomeando a mudança.
    if (editing && role !== initial.role) {
      const ok = await confirm({
        title: 'Alterar papel do usuário?',
        description: `Você está mudando o papel de ${initial.name} de ${ROLE_LABELS[initial.role]} para ${ROLE_LABELS[role]}. Isso altera o nível de acesso dele.`,
        variant: 'warning',
        confirmLabel: 'Alterar papel',
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      if (editing) {
        const body = { name, email, role, status };
        if (password) body.password = password;
        await updateUser(initial.id, body);
        toast.success('Usuário atualizado', `"${name}" foi salvo.`);
      } else {
        const body = { name, email, password, role };
        if (needsTenant) body.tenantId = Number(tenantId);
        await createUser(body);
        toast.success('Usuário criado', `"${name}" foi adicionado com sucesso.`);
      }
      onSaved();
    } catch (err) { toast.error('Não foi possível salvar', friendlyError(err.message)); }
    finally { setSaving(false); }
  };

  const cls = (err) => `w-full bg-dark-input border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none ${err ? 'border-rose-600' : 'border-dark-border focus:border-brand-emerald/60'}`;
  const errLine = (err) => err && <p className="text-[11px] text-rose-400 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{err}</p>;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-md bg-dark-card border border-dark-border rounded-2xl p-6 my-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold font-outfit text-white">{editing ? 'Editar Usuário' : 'Novo Usuário'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={submit} className="space-y-3.5" noValidate>
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Nome completo <Req /></label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={validate} className={cls(errors.name)} />
            {errLine(errors.name)}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">E-mail <Req /></label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={validate} className={cls(errors.email)} />
            {errLine(errors.email)}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Senha {editing ? <span className="text-slate-500">(em branco = manter)</span> : <Req />}</label>
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} onBlur={validate} className={cls(errors.password)} />
            {errLine(errors.password)}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Papel <Req /></label>
              <select value={role} onChange={(e) => setRole(e.target.value)} className={cls(false)}>
                {roleOptions.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            {editing && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">Status</label>
                <select value={status} onChange={(e) => setStatus(e.target.value)} className={cls(false)}>
                  <option value="active">Ativo</option>
                  <option value="disabled">Desativado</option>
                </select>
              </div>
            )}
          </div>
          {needsTenant && !editing && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Cliente <Req /></label>
              <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} onBlur={validate} className={cls(errors.tenantId)}>
                <option value="">Selecione…</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              {errLine(errors.tenantId)}
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

export default function UsersView() {
  const me = getUser();
  const isSuper = me?.role === 'superadmin';
  const toast = useToast();
  const confirm = useConfirm();
  const [users, setUsers] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [tenantFilter, setTenantFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);

  const tenantName = (id) => tenants.find((t) => t.id === id)?.name || (id ? `#${id}` : '—');

  const load = async () => {
    setLoading(true);
    try {
      if (isSuper && tenants.length === 0) setTenants(await listTenants());
      setUsers(await listUsers(isSuper && tenantFilter ? tenantFilter : undefined));
    } catch (e) { toast.error('Erro ao carregar usuários', friendlyError(e.message)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenantFilter]);

  const remove = async (u) => {
    const ok = await confirm({
      title: `Excluir usuário "${u.name}"?`,
      description: 'Esta ação é irreversível.',
      impact: [
        `Papel atual: ${ROLE_LABELS[u.role]}.`,
        u.role === 'gestor' ? 'Os vínculos deste gestor com equipes serão removidos.' : 'Sem vínculos de equipe como gestor.',
      ],
      variant: 'danger',
      confirmLabel: 'Excluir permanentemente',
    });
    if (!ok) return;
    try { await deleteUser(u.id); load(); toast.success('Usuário excluído', `"${u.name}" foi removido.`); }
    catch (e) { toast.error('Não foi possível excluir', friendlyError(e.message)); }
  };

  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-emerald/10 border border-brand-emerald/30 flex items-center justify-center text-brand-emerald"><Users className="w-5 h-5" /></div>
          <div>
            <h2 className="text-2xl font-bold font-outfit text-white">Usuários</h2>
            <p className="text-xs text-slate-400 mt-0.5">{isSuper ? 'Todos os clientes' : 'Do seu cliente'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isSuper && (
            <select value={tenantFilter} onChange={(e) => setTenantFilter(e.target.value)}
              className="bg-dark-input border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-brand-emerald">
              <option value="">Todos os clientes</option>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <button onClick={() => setModal({})} className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg shadow-md shadow-brand-emerald/20 active:scale-95">
            <Plus className="w-4 h-4 stroke-[3]" /> Novo Usuário
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : users.length === 0 ? (
        <div className="bg-dark-card border border-dark-border rounded-2xl p-12 text-center">
          <Users className="w-8 h-8 text-slate-500 mx-auto mb-3" />
          <h3 className="text-lg font-bold text-white mb-1">Nenhum usuário</h3>
          <p className="text-xs text-slate-400 mb-6">Crie o primeiro usuário{isSuper ? '' : ' do seu cliente'}.</p>
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
                  {isSuper && <th className="px-4 py-3 font-medium">Cliente</th>}
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-dark-border/50 last:border-0 hover:bg-dark-hover/40">
                    <td className="px-4 py-3 font-semibold text-white">{u.name}</td>
                    <td className="px-4 py-3 text-slate-300 font-mono text-xs">{u.email}</td>
                    <td className="px-4 py-3"><span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold border ${ROLE_BADGE[u.role]}`}>{ROLE_LABELS[u.role]}</span></td>
                    {isSuper && <td className="px-4 py-3 text-slate-400 text-xs">{u.tenantId ? tenantName(u.tenantId) : '—'}</td>}
                    <td className="px-4 py-3">
                      {u.status === 'active'
                        ? <span className="inline-flex items-center gap-1 text-xs text-brand-emerald"><CheckCircle2 className="w-3.5 h-3.5" />Ativo</span>
                        : <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Ban className="w-3.5 h-3.5" />Desativado</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => setModal(u)} title="Editar" className="p-1.5 rounded-md text-slate-400 hover:text-brand-emerald hover:bg-dark-hover"><Pencil className="w-4 h-4" /></button>
                        {u.id !== me?.id && <button onClick={() => remove(u)} title="Excluir" className="p-1.5 rounded-md text-slate-400 hover:text-rose-400 hover:bg-rose-950/50"><Trash2 className="w-4 h-4" /></button>}
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
        <UserModal initial={modal.id ? modal : null} isSuper={isSuper} tenants={tenants}
          defaultTenantId={isSuper ? '' : me?.tenantId} toast={toast} confirm={confirm}
          onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </main>
  );
}
