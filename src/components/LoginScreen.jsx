import React, { useState } from 'react';
import { ShieldCheck, LogIn, AlertCircle, Loader2 } from 'lucide-react';
import { login } from '../services/authApi';

export default function LoginScreen({ onSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await login(email.trim(), password);
      onSuccess?.(data);
    } catch (err) {
      setError(err.message || 'Não foi possível entrar. Verifique suas credenciais.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-dark-bg text-slate-100 flex items-center justify-center px-4 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-brand-emerald/10 border border-brand-emerald/30 flex items-center justify-center text-brand-emerald mb-3">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <h1 className="text-xl font-bold font-outfit text-white">Sentinela</h1>
          <p className="text-xs text-slate-400 mt-1">Monitoramento de conversas WhatsApp</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-dark-card border border-dark-border rounded-2xl p-6 space-y-4">
          {error && (
            <div className="flex items-center gap-2 text-xs bg-rose-950 border border-rose-800 text-rose-200 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">E-mail</label>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60"
              placeholder="voce@empresa.com"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">Senha</label>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-dark-bg border border-dark-border rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-brand-emerald/60"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
            {loading ? 'Entrando...' : 'Entrar'}
          </button>
        </form>

        <p className="text-center text-[11px] text-slate-500 mt-6">
          Acesso restrito · Qualidade &amp; Performance V4 Saman
        </p>
      </div>
    </div>
  );
}
