import React, { useState } from 'react';
import { UserCog, X, Loader2, Lock, AlertCircle } from 'lucide-react';
import { updateProfile } from '../services/adminApi';
import { getUser, updateStoredUser } from '../services/authApi';
import { validateFullName, validatePassword, friendlyError } from '../utils/validation';
import { useToast } from './ui/ToastProvider';

const Req = () => <span className="text-rose-400">*</span>;

export default function MeusDadosModal({ onClose, onUpdated }) {
  const me = getUser();
  const toast = useToast();
  const [name, setName] = useState(me?.name || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const validate = () => {
    const e = {};
    const nameErr = validateFullName(name);
    if (nameErr) e.name = nameErr;
    if (password) {
      const pErr = validatePassword(password);
      if (pErr) e.password = pErr;
      if (!confirm) e.confirm = 'Confirme a nova senha';
      else if (confirm !== password) e.confirm = 'As senhas não coincidem';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      const body = { name: name.trim() };
      if (password) body.password = password;
      const updated = await updateProfile(body);
      updateStoredUser({ name: updated.name });
      onUpdated?.(updated);
      toast.success(
        'Perfil atualizado',
        password ? 'Seu nome e senha foram atualizados com sucesso' : 'Seu nome foi atualizado com sucesso'
      );
      onClose();
    } catch (err) {
      toast.error('Não foi possível salvar', friendlyError(err.message));
    } finally {
      setSaving(false);
    }
  };

  const field = (hasError) =>
    `w-full bg-dark-input border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none ${
      hasError ? 'border-rose-600 focus:border-rose-500' : 'border-dark-border focus:border-brand-emerald/60'
    }`;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md bg-dark-card border border-dark-border rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-brand-emerald/10 border border-brand-emerald/30 flex items-center justify-center text-brand-emerald">
              <UserCog className="w-5 h-5" />
            </div>
            <h3 className="text-base font-bold font-outfit text-white">Meus dados</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <form onSubmit={submit} className="space-y-3.5" noValidate>
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Nome completo <Req /></label>
            <input value={name} onChange={(e) => setName(e.target.value)} onBlur={validate} className={field(errors.name)} />
            {errors.name && <p className="text-[11px] text-rose-400 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{errors.name}</p>}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">E-mail (login)</label>
            <div className="relative">
              <input value={me?.email || ''} disabled className="w-full bg-dark-bg/60 border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-500 cursor-not-allowed pr-9" />
              <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-600" />
            </div>
            <p className="text-[11px] text-slate-500 mt-1">O e-mail de login não pode ser alterado por aqui.</p>
          </div>

          <div className="pt-1 border-t border-dark-border/60">
            <p className="text-[11px] text-slate-500 mt-3 mb-2">Deixe em branco para manter a senha atual.</p>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Nova senha</label>
              <input type="password" autoComplete="new-password" value={password}
                onChange={(e) => setPassword(e.target.value)} onBlur={validate} className={field(errors.password)} />
              {errors.password && <p className="text-[11px] text-rose-400 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{errors.password}</p>}
            </div>
            <div className="mt-3">
              <label className="block text-xs font-medium text-slate-300 mb-1.5">Confirmar nova senha</label>
              <input type="password" autoComplete="new-password" value={confirm}
                onChange={(e) => setConfirm(e.target.value)} onBlur={validate} className={field(errors.confirm)} />
              {errors.confirm && <p className="text-[11px] text-rose-400 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{errors.confirm}</p>}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white">Cancelar</button>
            <button type="submit" disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg disabled:opacity-60">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Salvar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
