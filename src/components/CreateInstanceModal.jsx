import React, { useState } from 'react';
import { X, Plus, Phone, Tag } from 'lucide-react';
import { MANDATORY_WEBHOOK_URL } from '../services/quepasaApi';

export default function CreateInstanceModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('55');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;

    const formattedName = name.trim().toUpperCase().replace(/\s+/g, '-');
    const token = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const newInstance = {
      id: `inst-${Date.now()}`,
      name: formattedName,
      token: token,
      contactName: formattedName,
      phoneNumber: phoneNumber.trim() || 'Não conectado',
      avatarUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${formattedName}`,
      contactsCount: 0,
      messagesCount: 0,
      status: 'Disconnected',
      webhookUrl: MANDATORY_WEBHOOK_URL,
      updatedAt: new Date().toISOString(),
    };

    onCreate(newInstance);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-dark-card border border-dark-border w-full max-w-md rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-dark-border flex items-center justify-between bg-dark-surface">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand-emerald/15 border border-brand-emerald/30 flex items-center justify-center text-brand-emerald">
              <Plus className="w-5 h-5 stroke-[3]" />
            </div>
            <div>
              <h2 className="font-outfit font-bold text-lg text-white">
                Nova Instância
              </h2>
              <p className="text-xs text-slate-400">
                Criar uma nova caixa de conexão para WhatsApp
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-dark-hover transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          
          {/* Instance Identifier */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5 text-brand-emerald" />
              Nome / Identificador da Instância:
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="EX: INSTANCIA-VENDAS"
              className="w-full px-3.5 py-2.5 bg-dark-input border border-dark-border rounded-lg text-sm text-white placeholder-slate-500 uppercase focus:outline-none focus:border-brand-emerald font-mono"
              required
              autoFocus
            />
          </div>

          {/* Phone Number */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
              <Phone className="w-3.5 h-3.5 text-slate-400" />
              Número de Telefone (opcional):
            </label>
            <input
              type="text"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="5531999998888"
              className="w-full px-3.5 py-2.5 bg-dark-input border border-dark-border rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-emerald font-mono"
            />
          </div>

          {/* Submit Action */}
          <div className="pt-3 border-t border-dark-border flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-5 py-2 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg transition-all shadow-md shadow-brand-emerald/20"
            >
              <Plus className="w-4 h-4 stroke-[3]" />
              <span>Criar Instância</span>
            </button>
          </div>

        </form>

      </div>
    </div>
  );
}
