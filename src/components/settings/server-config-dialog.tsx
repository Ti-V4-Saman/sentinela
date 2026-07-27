import * as React from 'react';
import { Globe, Info, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
// @ts-expect-error — serviço JS sem tipos
import { saveServerConfig } from '../../services/quepasaApi';

type Config = { serverUrl?: string; apiKey?: string; useMock?: boolean };

export function ServerConfigDialog({
  config, onClose, onSave,
}: {
  config: Config;
  onClose: () => void;
  onSave: (c: { serverUrl: string; apiKey: string; useMock: boolean }) => void;
}) {
  const [serverUrl, setServerUrl] = React.useState(config.serverUrl || 'http://localhost:31000');
  const [apiKey, setApiKey] = React.useState(config.apiKey || '');
  const [useMock, setUseMock] = React.useState(Boolean(config.useMock));
  const [saving, setSaving] = React.useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    saveServerConfig(serverUrl, apiKey, useMock);
    onSave({ serverUrl, apiKey, useMock });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Servidor QuePasa</DialogTitle>
          <DialogDescription>Configurações da API do servidor de conexões</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Modo demonstração/teste */}
          <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-muted/40 p-3">
            <div className="min-w-0">
              <Label htmlFor="cfg-mock" className="text-foreground">Modo demonstração / teste</Label>
              <p className="text-xs text-muted-foreground">Permite testar a interface sem a API QuePasa aberta.</p>
            </div>
            <Switch id="cfg-mock" checked={useMock} onCheckedChange={setUseMock} />
          </div>

          <Field label="URL base do servidor QuePasa" htmlFor="cfg-url" required>
            <Input
              id="cfg-url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://seu-servidor:31000" className="font-mono" required
            />
          </Field>

          <Field label="Token de API global" htmlFor="cfg-key" hint="Opcional — usado no cabeçalho de autenticação das chamadas ao servidor.">
            <Input
              id="cfg-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder="Chave secreta da API…" className="font-mono"
            />
          </Field>

          <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
            <span>Ao salvar, a dashboard passa a consultar e sincronizar as conexões diretamente da API QuePasa configurada.</span>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />} Salvar servidor
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
