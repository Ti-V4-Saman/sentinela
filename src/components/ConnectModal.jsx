import React, { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { 
  X, 
  QrCode, 
  CheckCircle2, 
  RotateCw, 
  ShieldCheck,
  AlertCircle
} from 'lucide-react';
import { fetchQRCode, registerQuePasaWebhook, checkInstanceRealtimeStatus, MANDATORY_WEBHOOK_URL } from '../services/quepasaApi';

export default function ConnectModal({ instance, onClose, onConnectedSuccess }) {
  const [loading, setLoading] = useState(true);
  const [qrValue, setQrValue] = useState('');
  const [qrImageUrl, setQrImageUrl] = useState('');
  const [statusMessage, setStatusMessage] = useState('Gerando QR Code...');
  const [step, setStep] = useState(1); // 1: Scan, 2: Registering Webhook, 3: Success
  const [error, setError] = useState('');

  // Load QR code on mount
  useEffect(() => {
    loadQRCode();
  }, [instance]);

  const connectingRef = React.useRef(false);

  // Auto-detect when QR code scan connects on WhatsApp server
  useEffect(() => {
    if (step !== 1) return;

    const checkAutoConnection = async () => {
      if (connectingRef.current) return;
      try {
        const res = await checkInstanceRealtimeStatus(instance);
        const status = typeof res === 'string' ? res : res?.status;
        const livePhone = typeof res === 'object' ? res?.phoneNumber : '';
        
        if (status === 'Connected') {
          connectingRef.current = true;
          console.log('[ConnectModal] Leitura do QR Code detectada! Finalizando conexão...');
          handleConfirmConnection(livePhone);
        }
      } catch (e) {
        // Silent polling catch
      }
    };

    const intervalId = setInterval(checkAutoConnection, 1500);
    return () => clearInterval(intervalId);
  }, [step, instance]);

  const loadQRCode = async () => {
    try {
      setLoading(true);
      setError('');
      setStatusMessage('Conectando ao servidor QuePasa...');
      
      const res = await fetchQRCode(instance, instance?.phoneNumber || '55');
      setQrValue(res.qrCode || '');
      setQrImageUrl(res.qrImageUrl || '');
      setStatusMessage('Aguardando leitura no WhatsApp...');
    } catch (err) {
      setError(err.message || 'Erro ao carregar QR Code');
    } finally {
      setLoading(false);
    }
  };

  // Confirm connection flow (called automatically after QR scan detected)
  const handleConfirmConnection = async (detectedPhone = '') => {
    setLoading(true);
    setStep(2);
    setStatusMessage('Finalizando conexão com QuePasa...');

    try {
      await registerQuePasaWebhook(instance).catch(() => null);

      setStep(3);
      setStatusMessage('Número conectado com sucesso!');

      const finalPhone = detectedPhone || instance?.phoneNumber || '';
      const formattedPhone = finalPhone ? (finalPhone.startsWith('55') ? finalPhone : `55${finalPhone}`) : '';

      // Complete flow & auto close modal
      setTimeout(() => {
        onConnectedSuccess({
          ...instance,
          status: 'Connected',
          phoneNumber: formattedPhone || instance.phoneNumber,
          webhookUrl: MANDATORY_WEBHOOK_URL,
          updatedAt: new Date().toISOString(),
        });
        onClose();
      }, 1200);

    } catch (err) {
      // If anything fails, still mark connected if status was detected
      setStep(3);
      setTimeout(() => {
        onConnectedSuccess({
          ...instance,
          status: 'Connected',
          updatedAt: new Date().toISOString(),
        });
        onClose();
      }, 1200);
    } finally {
      setLoading(false);
    }
  };


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-dark-card border border-dark-border w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-dark-border flex items-center justify-between bg-dark-surface">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand-emerald/15 border border-brand-emerald/30 flex items-center justify-center text-brand-emerald">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-outfit font-bold text-lg text-white">
                Conectar WhatsApp - {instance.name}
              </h2>
              <p className="text-xs text-slate-400">
                Escaneie o QR Code com o WhatsApp
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

        {/* Body Content */}
        <div className="p-6 flex flex-col items-center justify-center text-center">

          {error && (
            <div className="w-full mb-4 p-3 bg-rose-950/60 border border-rose-800 text-rose-200 rounded-lg text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {step === 1 && (
            <div className="flex flex-col items-center">
              <p className="text-xs text-slate-300 mb-4">
                Abra o WhatsApp no celular &gt; <strong>Aparelhos Conectados</strong> &gt; <strong>Conectar um aparelho</strong>
              </p>

              {/* QR Container */}
              <div className="p-4 bg-white rounded-xl shadow-inner border-4 border-dark-border relative group mb-4">
                {loading ? (
                  <div className="w-56 h-56 flex flex-col items-center justify-center text-slate-700">
                    <RotateCw className="w-8 h-8 animate-spin text-brand-emerald mb-2" />
                    <span className="text-xs font-medium">Gerando QR Code...</span>
                  </div>
                ) : qrImageUrl ? (
                  <img 
                    src={qrImageUrl} 
                    alt="QR Code WhatsApp QuePasa" 
                    className="w-[220px] h-[220px] object-contain rounded"
                  />
                ) : (
                  <QRCodeSVG 
                    value={qrValue || 'quepasa-demo'} 
                    size={220} 
                    level="H" 
                    includeMargin={true} 
                  />
                )}
              </div>

              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="w-2 h-2 rounded-full bg-brand-emerald animate-ping" />
                <span>{statusMessage}</span>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="py-8 flex flex-col items-center text-brand-emerald">
              <RotateCw className="w-12 h-12 animate-spin mb-4" />
              <h3 className="font-bold text-white text-base mb-1">Configurando Conexão</h3>
              <p className="text-xs text-slate-400 max-w-xs">{statusMessage}</p>
            </div>
          )}

          {step === 3 && (
            <div className="py-8 flex flex-col items-center text-brand-emerald">
              <CheckCircle2 className="w-14 h-14 mb-4 text-brand-emerald animate-bounce" />
              <h3 className="font-bold text-white text-lg mb-1">Conectado com Sucesso!</h3>
              <p className="text-xs text-slate-300">
                Instância vinculada e pronta para uso.
              </p>
            </div>
          )}

        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-dark-border bg-dark-surface flex items-center justify-between">
          <button
            onClick={loadQRCode}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-dark-card hover:bg-dark-hover text-slate-300 rounded-lg border border-dark-border transition-colors disabled:opacity-50"
          >
            <RotateCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Recarregar QR
          </button>

          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white transition-colors"
          >
            Cancelar
          </button>
        </div>

      </div>
    </div>
  );
}
