import * as React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { QrCode, CheckCircle2, RotateCw, AlertCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
// @ts-expect-error — serviço JS sem tipos
import { fetchQRCode, registerQuePasaWebhook, checkInstanceRealtimeStatus, MANDATORY_WEBHOOK_URL } from '../../services/quepasaApi';

type Instance = { id: string; name: string; phoneNumber?: string; [k: string]: unknown };

export function ConnectDialog({
  instance, onClose, onConnectedSuccess,
}: {
  instance: Instance;
  onClose: () => void;
  onConnectedSuccess: (updated: Record<string, unknown>) => void;
}) {
  const [loading, setLoading] = React.useState(true);
  const [qrValue, setQrValue] = React.useState('');
  const [qrImageUrl, setQrImageUrl] = React.useState('');
  const [statusMessage, setStatusMessage] = React.useState('Gerando QR Code...');
  const [step, setStep] = React.useState(1); // 1: Scan, 2: Registering Webhook, 3: Success
  const [error, setError] = React.useState('');
  const connectingRef = React.useRef(false);

  const loadQRCode = React.useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      setStatusMessage('Conectando ao servidor QuePasa...');
      const res = await fetchQRCode(instance, instance?.phoneNumber || '55');
      setQrValue(res.qrCode || '');
      setQrImageUrl(res.qrImageUrl || '');
      setStatusMessage('Aguardando leitura no WhatsApp...');
    } catch (err) {
      setError((err as Error).message || 'Erro ao carregar QR Code');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance]);

  // Carrega o QR ao montar / trocar instância.
  React.useEffect(() => { loadQRCode(); }, [loadQRCode]);

  // Confirma a conexão (chamado automaticamente ao detectar a leitura do QR).
  const handleConfirmConnection = React.useCallback(async (detectedPhone = '') => {
    setLoading(true);
    setStep(2);
    setStatusMessage('Finalizando conexão com QuePasa...');
    try {
      await registerQuePasaWebhook(instance).catch(() => null);
      setStep(3);
      setStatusMessage('Número conectado com sucesso!');
      const finalPhone = detectedPhone || instance?.phoneNumber || '';
      const formattedPhone = finalPhone ? (finalPhone.startsWith('55') ? finalPhone : `55${finalPhone}`) : '';
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
    } catch {
      setStep(3);
      setTimeout(() => {
        onConnectedSuccess({ ...instance, status: 'Connected', updatedAt: new Date().toISOString() });
        onClose();
      }, 1200);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance]);

  // Polling: detecta quando o QR é lido no servidor (a cada 1.5s), só no passo 1.
  // Limpa o interval ao fechar/desmontar; connectingRef evita confirmações concorrentes.
  React.useEffect(() => {
    if (step !== 1) return;
    const checkAutoConnection = async () => {
      if (connectingRef.current) return;
      try {
        const res = await checkInstanceRealtimeStatus(instance);
        const status = typeof res === 'string' ? res : res?.status;
        const livePhone = typeof res === 'object' ? res?.phoneNumber : '';
        if (status === 'Connected') {
          connectingRef.current = true;
          handleConfirmConnection(livePhone);
        }
      } catch {
        /* polling silencioso */
      }
    };
    const intervalId = setInterval(checkAutoConnection, 1500);
    return () => clearInterval(intervalId);
  }, [step, instance, handleConfirmConnection]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Conectar WhatsApp — {instance.name}</DialogTitle>
          <DialogDescription>Escaneie o QR Code com o WhatsApp</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center justify-center text-center">
          {error && (
            <div className="mb-4 flex w-full items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {step === 1 && (
            <div className="flex flex-col items-center">
              <p className="mb-4 text-xs text-muted-foreground">
                Abra o WhatsApp no celular &gt; <strong className="text-foreground">Aparelhos Conectados</strong> &gt; <strong className="text-foreground">Conectar um aparelho</strong>
              </p>

              {/* Área do QR: fundo branco é obrigatório para leitura do código. */}
              <div className="relative mb-4 rounded-lg border border-border bg-white p-4 shadow-inner">
                {loading ? (
                  <div className="flex h-56 w-56 flex-col items-center justify-center text-neutral-600">
                    <RotateCw className="mb-2 h-8 w-8 animate-spin text-primary" />
                    <span className="text-xs font-medium">Gerando QR Code...</span>
                  </div>
                ) : qrImageUrl ? (
                  <img src={qrImageUrl} alt="QR Code WhatsApp QuePasa" className="h-[220px] w-[220px] rounded object-contain" />
                ) : (
                  <QRCodeSVG value={qrValue || 'quepasa-demo'} size={220} level="H" includeMargin />
                )}
              </div>

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-2 w-2 animate-ping rounded-full bg-primary" />
                <span>{statusMessage}</span>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col items-center py-8">
              <RotateCw className="mb-4 h-12 w-12 animate-spin text-primary" />
              <h3 className="mb-1 text-base font-semibold text-foreground">Configurando conexão</h3>
              <p className="max-w-xs text-xs text-muted-foreground">{statusMessage}</p>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col items-center py-8">
              <CheckCircle2 className="mb-4 h-14 w-14 text-success" />
              <h3 className="mb-1 text-lg font-semibold text-foreground">Conectado com sucesso!</h3>
              <p className="text-xs text-muted-foreground">Conexão vinculada e pronta para uso.</p>
            </div>
          )}
        </div>

        {step === 1 && (
          <DialogFooter className="sm:justify-between">
            <Button variant="outline" size="sm" onClick={loadQRCode} disabled={loading}>
              <RotateCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Recarregar QR
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>Cancelar</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
