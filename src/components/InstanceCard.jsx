import React, { useState } from 'react';
import { 
  Settings, 
  Copy, 
  Check, 
  Eye, 
  EyeOff, 
  QrCode, 
  Power, 
  Trash2, 
  XCircle,
  Lock
} from 'lucide-react';


export default function InstanceCard({ 
  instance, 
  onConnect, 
  onDisconnect, 
  onDelete
}) {
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imgError, setImgError] = useState(false);

  const handleCopyToken = () => {
    navigator.clipboard.writeText(instance.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isConnected = instance.status === 'Connected';
  const initialLetter = (instance.contactName || instance.name || 'W').charAt(0).toUpperCase();

  // Dynamic avatar URL generation
  const avatarSrc = instance.avatarUrl || 
    (instance.phoneNumber 
      ? `https://api.dicebear.com/7.x/avataaars/svg?seed=${instance.phoneNumber}` 
      : `https://api.dicebear.com/7.x/avataaars/svg?seed=${instance.name}`);

  return (
    <div className="bg-dark-card border border-dark-border hover:border-brand-emerald/40 rounded-xl p-4 sm:p-5 card-glow flex flex-col justify-between relative group transition-all w-full min-w-0">
      
      {/* Top Header: Instance Title & Gear Icon */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="font-outfit font-bold text-base text-white tracking-wider uppercase truncate">
            {instance.name}
          </h3>
          <button 
            title="Configurações da Instância"
            className="text-slate-400 hover:text-white p-1 rounded-md hover:bg-dark-hover transition-colors shrink-0"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>

        {/* Masked Token Input Container matching Evolution API screenshot */}
        <div className="bg-dark-input border border-dark-border rounded-lg px-3 py-2 flex items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <Lock className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span className="font-mono text-xs text-slate-300 truncate select-none">
              {showToken ? `${instance.token.slice(0, 8)}-****-****-****-${instance.token.slice(-4)}` : '••••••••-••••-••••-••••-••••••••••••'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 text-slate-400">
            <button 
              onClick={handleCopyToken}
              title={copied ? "Copiado!" : "Copiar Token"}
              className="hover:text-brand-emerald p-1 rounded transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-brand-emerald" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <button 
              onClick={() => setShowToken(!showToken)}
              title={showToken ? "Ocultar Token" : "Visualizar Token (Requer Login)"}
              className="hover:text-white p-1 rounded transition-colors"
            >
              {showToken ? <EyeOff className="w-3.5 h-3.5 text-brand-emerald" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>


        {/* Profile Info: Avatar, Name, Phone & Stats */}
        <div className="flex items-center gap-3 mb-4">
          <div className="relative shrink-0">
            {!imgError ? (
              <img 
                src={avatarSrc} 
                alt={instance.contactName}
                onError={() => setImgError(true)}
                className="w-12 h-12 rounded-full bg-dark-surface border border-dark-border object-cover" 
              />
            ) : (
              <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-brand-emeraldDark to-brand-emerald text-black font-bold font-outfit text-lg flex items-center justify-center border border-dark-border shadow">
                {initialLetter}
              </div>
            )}
            <span className={`absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full border-2 border-dark-card ${isConnected ? 'bg-brand-emerald status-pulse-connected' : 'bg-rose-600'}`} />
          </div>

          <div className="flex-1 min-w-0">
            <h4 className="font-semibold text-sm text-white truncate">
              {/* contactName = real WhatsApp pushname captured on connect; fallback to instance name */}
              {instance.contactName || instance.name}
            </h4>
            <p className="text-xs font-mono text-slate-400 mb-1 truncate">
              {/* Strip device suffix ":73" from phone display */}
              {instance.phoneNumber ? instance.phoneNumber.split(':')[0] : 'Não conectado'}
            </p>
          </div>
        </div>
      </div>

      {/* Card Footer: Status Pill & Action Buttons */}
      <div className="pt-3 border-t border-dark-border/60 flex flex-wrap items-center justify-between gap-2.5">
        
        {/* Left Side: Status Pill */}
        <div className="flex items-center gap-2">
          {isConnected ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-brand-emerald/15 text-brand-emerald border border-brand-emerald/30">
              <span className="w-2 h-2 rounded-full bg-brand-emerald animate-pulse" />
              Connected
            </span>
          ) : (
            <button
              onClick={() => onConnect(instance)}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-800 transition-colors"
            >
              <XCircle className="w-3.5 h-3.5" />
              Disconnected
            </button>
          )}
        </div>

        {/* Right Side: Primary Actions */}
        <div className="flex items-center gap-1.5 flex-wrap">
          
          {/* If Disconnected: Connect / QR Code button */}
          {!isConnected && (
            <button
              onClick={() => onConnect(instance)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg transition-all shadow-sm"
              title="Escanear QR Code para Conectar"
            >
              <QrCode className="w-3.5 h-3.5" />
              Conectar
            </button>
          )}

          {/* If Connected: Disconnect button */}
          {isConnected && (
            <button
              onClick={() => onDisconnect(instance)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-dark-hover hover:bg-rose-950 text-slate-300 hover:text-rose-300 border border-dark-border hover:border-rose-800 rounded-lg transition-colors"
              title="Desconectar Instância"
            >
              <Power className="w-3.5 h-3.5" />
              Sair
            </button>
          )}

          {/* Delete Button */}
          <button
            onClick={() => onDelete(instance.id)}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-danger hover:bg-danger-hover text-white rounded-lg transition-colors shadow-sm"
            title="Excluir Instância"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </button>

        </div>

      </div>

    </div>
  );
}

