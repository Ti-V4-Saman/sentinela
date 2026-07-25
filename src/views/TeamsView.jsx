import React from 'react';
import { UsersRound, Hammer } from 'lucide-react';

export default function TeamsView() {
  return (
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-brand-emerald/10 border border-brand-emerald/30 flex items-center justify-center text-brand-emerald">
          <UsersRound className="w-5 h-5" />
        </div>
        <h2 className="text-2xl font-bold font-outfit text-white">Equipes</h2>
      </div>
      <div className="bg-dark-card border border-dark-border rounded-2xl p-12 text-center text-slate-400">
        <Hammer className="w-8 h-8 mx-auto mb-3 text-slate-500" />
        Tela de equipes em construção.
      </div>
    </main>
  );
}
