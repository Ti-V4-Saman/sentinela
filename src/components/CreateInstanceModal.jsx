import React, { useState } from 'react';
import { X, Plus, Phone, Tag, AlertCircle, Loader2 } from 'lucide-react';
import { MANDATORY_WEBHOOK_URL } from '../services/quepasaApi';

const Req = () => <span className="text-rose-400">*</span>;

export default function CreateInstanceModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('55');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(''); // erro do backend (ex.: número duplicado → reconectar)
  const [submitting, setSubmitting] = useState(false);

  const validate = () => {
    const e = {};
    if (!name.trim()) e.name = 'Campo obrigatório';
    const digits = (phoneNumber || '').replace(/\D/g, '');
    if (!digits) e.phone = 'Campo obrigatório';
    else if (digits.length < 12) e.phone = 'Informe o número com país e DDD, ex: 5531999990000';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');
    if (!validate()) return;

    const formattedName = name.trim().toUpperCase().replace(/\s+/g, '-');
    const token = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newInstance = {
      id: `inst-${Date.now()}`,
      name: formattedName,
      token,
      contactName: formattedName,
      phoneNumber: phoneNumber.trim(),
      avatarUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${formattedName}`,
      status: 'Disconnected',
      webhookUrl: MANDATORY_WEBHOOK_URL,
    };

    setSubmitting(true);
    try {
      await onCreate(newInstance);
    } catch (err) {
      // Ex.: "Já existe uma instância ativa para esse número (dono: X). Reconecte a instância 'Y'…"
      setFormError(err.message || 'Não foi possível criar a instância.');
    } finally {
      setSubmitting(false);
    }
  };

  const field = (err) =>
    `w-full px-3.5 py-2.5 bg-dark-input border rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none font-mono ${
      err ? 'border-rose-600' : 'border-dark-border focus:border-brand-emerald'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-dark-card border border-dark-border w-full max-w-md rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-dark-border flex items-center justify-between bg-dark-surface">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand-emerald/15 border border-brand-emerald/30 flex items-center justify-center text-brand-emerald">
              <Plus className="w-5 h-5 stroke-[3]" />
            </div>
            <div>
              <h2 className="font-outfit font-bold text-lg text-white">Nova Instância</h2>
              <p className="text-xs text-slate-400">Conecte um número de WhatsApp</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-dark-hover transition-colors"><X className="w-5 h-5" /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4" noValidate>
          {formError && (
            <div className="flex items-start gap-2 text-xs bg-amber-950 border border-amber-800 text-amber-200 rounded-lg px-3 py-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{formError}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5 text-brand-emerald" /> Nome / Identificador <Req />
            </label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} onBlur={validate}
              placeholder="EX: INSTANCIA-VENDAS" className={`${field(errors.name)} uppercase`} autoFocus />
            {errors.name && <p className="text-[11px] text-rose-400 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{errors.name}</p>}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
              <Phone className="w-3.5 h-3.5 text-slate-400" /> Número de telefone <Req />
            </label>
            <input type="text" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} onBlur={validate}
              placeholder="5531999990000" className={field(errors.phone)} />
            {errors.phone
              ? <p className="text-[11px] text-rose-400 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{errors.phone}</p>
              : <p className="text-[11px] text-slate-500 mt-1">Com código do país e DDD. Não é possível abrir duas instâncias para o mesmo número.</p>}
          </div>

          <div className="pt-3 border-t border-dark-border flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white transition-colors">Cancelar</button>
            <button type="submit" disabled={submitting}
              className="flex items-center gap-1.5 px-5 py-2 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg transition-all shadow-md shadow-brand-emerald/20 disabled:opacity-60">
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 stroke-[3]" />}
              <span>Criar Instância</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
