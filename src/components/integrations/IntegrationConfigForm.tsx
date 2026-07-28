import * as React from 'react';
import { KeyRound, Send, Copy, Check, ShieldAlert } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Field } from '@/components/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import {
  saveIntegration, regenerateIntegrationSecret, testIntegration,
} from '../../services/adminApi';
import { useToast } from '../ui/ToastProvider';
import { friendlyError } from '../../utils/validation';

// Fusos comuns o bastante para cobrir a operação do Sentinela sem virar um seletor infinito.
const TIMEZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Fortaleza',
  'America/Bahia',
  'America/Rio_Branco',
  'America/Noronha',
  'UTC',
];

export type IntegrationConfig = {
  id?: number;
  active: boolean;
  target_url: string;
  run_at_time: string;
  timezone: string;
  include_direct: boolean;
  include_groups: boolean;
  include_from_me: boolean;
  include_audio_transcripts: boolean;
  secret_masked?: string | null;
} | null;

type Confirm = (o: {
  title: string; description?: string; variant?: 'danger' | 'warning'; confirmLabel?: string;
}) => Promise<boolean>;

export function IntegrationConfigForm({
  config, tenantId, externalEnabled, confirm, onSaved,
}: {
  config: IntegrationConfig;
  tenantId?: number;
  externalEnabled: boolean;
  confirm: Confirm;
  onSaved: () => Promise<void> | void;
}) {
  const toast = useToast();

  const [active, setActive] = React.useState(!!config?.active);
  const [targetUrl, setTargetUrl] = React.useState(config?.target_url || '');
  const [runAtTime, setRunAtTime] = React.useState(config?.run_at_time || '03:00');
  const [timezone, setTimezone] = React.useState(config?.timezone || 'America/Sao_Paulo');
  const [includeDirect, setIncludeDirect] = React.useState(config?.include_direct ?? true);
  const [includeGroups, setIncludeGroups] = React.useState(config?.include_groups ?? true);
  const [includeFromMe, setIncludeFromMe] = React.useState(config?.include_from_me ?? true);
  const [includeAudio, setIncludeAudio] = React.useState(config?.include_audio_transcripts ?? false);

  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);
  const [testing, setTesting] = React.useState(false);

  const [revealedSecret, setRevealedSecret] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const configured = !!config?.id;

  const validate = () => {
    const e: Record<string, string> = {};
    if (!targetUrl.trim()) e.target_url = 'Campo obrigatório';
    else if (!/^https?:\/\//i.test(targetUrl.trim())) e.target_url = 'Informe uma URL válida (https://...)';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(runAtTime)) e.run_at_time = 'Formato HH:MM';
    if (!timezone) e.timezone = 'Selecione um fuso horário';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      await saveIntegration(tenantId, {
        active,
        target_url: targetUrl.trim(),
        run_at_time: runAtTime,
        timezone,
        include_direct: includeDirect,
        include_groups: includeGroups,
        include_from_me: includeFromMe,
        include_audio_transcripts: includeAudio,
      });
      toast.success('Integração salva', 'As configurações foram atualizadas.');
      await onSaved();
    } catch (e) {
      toast.error('Não foi possível salvar', friendlyError((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerate = async () => {
    const ok = await confirm({
      title: 'Regenerar secret da integração?',
      description: 'O secret anterior deixa de ser válido imediatamente. Qualquer verificação de assinatura feita pelo destino com o secret atual passará a falhar até que ele seja atualizado.',
      variant: 'warning',
      confirmLabel: 'Regenerar secret',
    });
    if (!ok) return;
    setRegenerating(true);
    try {
      const res = await regenerateIntegrationSecret(tenantId);
      setRevealedSecret(res.secret);
      setCopied(false);
      toast.success('Secret regenerado', 'Copie o novo valor agora — ele não será exibido novamente.');
      await onSaved();
    } catch (e) {
      toast.error('Não foi possível regenerar', friendlyError((e as Error).message));
    } finally {
      setRegenerating(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await testIntegration(tenantId);
      if (res.status === 'disabled') {
        toast.warning('Integração externa desativada', 'O ambiente não está autorizado a enviar — configure normalmente, o teste será possível quando a integração externa for habilitada.');
      } else if (res.status === 'success') {
        toast.success('Conectividade OK', `Destino respondeu HTTP ${res.http_code}.`);
      } else {
        toast.error('Falha de conectividade', res.http_code ? `Destino respondeu HTTP ${res.http_code}.` : 'Não foi possível alcançar a URL de destino.');
      }
    } catch (e) {
      toast.error('Não foi possível testar', friendlyError((e as Error).message));
    } finally {
      setTesting(false);
    }
  };

  const copySecret = async () => {
    if (!revealedSecret) return;
    try {
      await navigator.clipboard.writeText(revealedSecret);
      setCopied(true);
    } catch {
      // Sem permissão de clipboard: usuário ainda pode selecionar o texto manualmente.
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="font-heading text-lg font-semibold text-foreground">Configuração</CardTitle>
            <CardDescription>Envio diário de conversas via webhook assinado.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="integration-active" className="text-sm text-muted-foreground">
              {active ? 'Ativa' : 'Inativa'}
            </Label>
            <Switch id="integration-active" checked={active} onCheckedChange={setActive} aria-label="Ativar integração" />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="URL de destino" htmlFor="integration-url" required error={errors.target_url} hint="Endpoint HTTPS que receberá o lote diário." className="sm:col-span-2">
            <Input
              id="integration-url"
              type="url"
              placeholder="https://exemplo.com/webhooks/sentinela"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              aria-invalid={!!errors.target_url}
            />
          </Field>

          <Field label="Horário de envio" htmlFor="integration-time" required error={errors.run_at_time} hint="Formato 24h (HH:MM), no fuso selecionado.">
            <Input
              id="integration-time"
              type="time"
              value={runAtTime}
              onChange={(e) => setRunAtTime(e.target.value)}
              aria-invalid={!!errors.run_at_time}
            />
          </Field>

          <Field label="Fuso horário" htmlFor="integration-tz" required error={errors.timezone}>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="integration-tz" className="w-full" aria-label="Fuso horário">
                <SelectValue placeholder="Selecione o fuso" />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div>
          <p className="mb-3 text-sm font-medium text-foreground">Conteúdo incluído no lote</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label htmlFor="opt-direct" className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
              <span className="text-sm text-foreground">Conversas diretas</span>
              <Switch id="opt-direct" checked={includeDirect} onCheckedChange={setIncludeDirect} />
            </label>
            <label htmlFor="opt-groups" className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
              <span className="text-sm text-foreground">Grupos</span>
              <Switch id="opt-groups" checked={includeGroups} onCheckedChange={setIncludeGroups} />
            </label>
            <label htmlFor="opt-fromme" className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
              <span className="text-sm text-foreground">Mensagens enviadas por mim</span>
              <Switch id="opt-fromme" checked={includeFromMe} onCheckedChange={setIncludeFromMe} />
            </label>
            <label htmlFor="opt-audio" className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
              <span className="text-sm text-foreground">Transcrições de áudio</span>
              <Switch id="opt-audio" checked={includeAudio} onCheckedChange={setIncludeAudio} />
            </label>
          </div>
        </div>

        <div>
          <p className="mb-3 text-sm font-medium text-foreground">Secret de assinatura</p>
          <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 font-mono text-sm text-muted-foreground">
              <KeyRound className="h-4 w-4 shrink-0" />
              {config?.secret_masked || 'Nenhum secret gerado ainda'}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={handleRegenerate} disabled={regenerating || !configured}>
              {regenerating ? 'Gerando…' : 'Regenerar secret'}
            </Button>
          </div>
          {!configured && (
            <p className="mt-1.5 text-xs text-muted-foreground">Salve a configuração antes de gerar o secret.</p>
          )}
        </div>
      </CardContent>

      <CardFooter className="flex flex-col items-stretch gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground sm:max-w-sm">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          O teste valida apenas conectividade, URL e proteção contra SSRF — não confirma a
          verificação de assinatura fim a fim, pois o secret é armazenado com hash e não pode
          ser lido de volta pelo servidor.
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={handleTest} disabled={testing || !configured || !externalEnabled} title={!externalEnabled ? 'Integração externa desativada no ambiente' : undefined}>
            <Send className="h-4 w-4" /> {testing ? 'Enviando…' : 'Enviar teste'}
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar'}
          </Button>
        </div>
      </CardFooter>

      <Dialog open={!!revealedSecret} onOpenChange={(open) => { if (!open) setRevealedSecret(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Secret gerado</DialogTitle>
            <DialogDescription>
              Copie o valor agora — por segurança, ele não será exibido novamente. Apenas a versão
              mascarada ficará visível na tela de configuração.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5">
            <code className="flex-1 select-all break-all font-mono text-sm text-foreground">{revealedSecret}</code>
            <Button type="button" variant="outline" size="icon-sm" onClick={copySecret} aria-label="Copiar secret">
              {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setRevealedSecret(null)}>Já copiei, fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
