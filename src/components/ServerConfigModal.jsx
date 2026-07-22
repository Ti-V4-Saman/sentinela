import React, { useState } from 'react';
import { X, Globe, Key, Shield, Check, Info } from 'lucide-react';
import { saveServerConfig } from '../services/quepasaApi';

export default function ServerConfigModal({ config, onClose, onSave }) {
  const [serverUrl, setServerUrl] = useState(config.serverUrl || 'http://localhost:31000');
  const [apiKey, setApiKey] = useState(config.apiKey || '');
  const [useMock, setUseMock] = useState(config.useMock);
  const [saved, setSaved] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    saveServerConfig(serverUrl, apiKey, useMock);
    onSave({ serverUrl, apiKey, useMock });
    setSaved(true);
    setTimeout(() => {
      onClose();
    }, 600);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-dark-card border border-dark-border w-full max-w-md rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-dark-border flex items-center justify-between bg-dark-surface">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-outfit font-bold text-lg text-white">
                Servidor QuePasa
              </h2>
              <p className="text-xs text-slate-400">
                Configurações da API do seu servidor
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
          
          {/* Mode Switcher */}
          <div className="p-3 bg-dark-bg border border-dark-border rounded-xl flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-white block">
                Modo Demonstração / Teste
              </span>
              <span className="text-[11px] text-slate-400 block">
                Permite testar a interface sem ter a API QuePasa aberta
              </span>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={useMock}
                onChange={(e) => setUseMock(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-dark-hover peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500"></div>
            </label>
          </div>

          {/* Server URL Input */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-brand-emerald" />
              URL Base do Servidor QuePasa:
            </label>
            <input
              type="text"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://seu-servidor:31000"
              className="w-full px-3.5 py-2.5 bg-dark-input border border-dark-border rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-emerald font-mono"
              required
            />
            <span className="text-[11px] text-slate-500 mt-1 block">
              Exemplo: http://192.168.1.100:31000 ou https://quepasa.suadominio.com
            </span>
          </div>

          {/* Master API Token Input */}
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5">
              <Key className="w-3.5 h-3.5 text-amber-400" />
              Token de API Global (Opcional):
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Sua chave secreta da API..."
              className="w-full px-3.5 py-2.5 bg-dark-input border border-dark-border rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-brand-emerald font-mono"
            />
          </div>

          {/* Info note */}
          <div className="bg-dark-bg/60 border border-dark-border/80 rounded-lg p-3 text-xs text-slate-400 flex items-start gap-2">
            <Info className="w-4 h-4 text-brand-emerald shrink-0 mt-0.5" />
            <span>
              Ao salvar, a dashboard tentará consultar e sincronizar as instâncias diretamente da sua API QuePasa.
            </span>
          </div>

          {/* Footer Actions */}
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
              {saved ? <Check className="w-4 h-4" /> : null}
              <span>{saved ? 'Salvo!' : 'Salvar Servidor'}</span>
            </button>
          </div>

        </form>

      </div>
    </div>
  );
}
