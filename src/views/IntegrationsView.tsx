import * as React from 'react';
import { AlertCircle, AlertTriangle, Plug } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { IntegrationConfigForm, type IntegrationConfig } from '@/components/integrations/IntegrationConfigForm';
import { BatchHistory } from '@/components/integrations/BatchHistory';
import { SelectClientPrompt } from '@/components/shell/SelectClientPrompt';
import { useTenant } from '@/context/TenantContext';
import { getIntegration } from '../services/adminApi';
import { getUser } from '../services/authApi';
import { useToast } from '../components/ui/ToastProvider';
import { useConfirm } from '../components/ui/ConfirmProvider';
import { friendlyError } from '../utils/validation';

export default function IntegrationsView({ tenantId: locked }: { tenantId?: number }) {
  const me = getUser();
  const isSuper = me?.role === 'superadmin' && locked == null;
  const tenant = useTenant();
  const toast = useToast();
  const confirm = useConfirm();

  const [config, setConfig] = React.useState<IntegrationConfig>(null);
  const [externalEnabled, setExternalEnabled] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  // Guarda de segurança: mesmo com a Sidebar já restringindo o item a modo cliente, a view não
  // deve montar dados de nenhum tenant quando o superadmin está na visão global.
  const blockedGlobalView = isSuper && locked == null && tenant.isGlobalView;

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getIntegration(locked);
      setConfig(res.config);
      setExternalEnabled(res.externalEnabled);
    } catch (e) {
      setError(friendlyError((e as Error).message) || 'Falha ao carregar a integração');
    } finally {
      setLoading(false);
    }
  }, [locked]);

  React.useEffect(() => {
    if (blockedGlobalView) return;
    load();
  }, [load, blockedGlobalView]);

  if (blockedGlobalView) {
    return <SelectClientPrompt kind="integrations" />;
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 lg:px-8">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold text-foreground">Integrações</h1>
        <p className="text-sm text-muted-foreground">Envio diário de conversas por webhook (Configurações &gt; Integrações)</p>
      </div>

      {!loading && !error && !externalEnabled && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="text-sm text-foreground">
            Integração externa desativada no ambiente — você pode configurar, mas nenhum envio
            externo ocorrerá.
          </p>
        </div>
      )}

      {error ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card px-6 py-16 text-center shadow-[var(--shadow-card)]">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertCircle className="h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold text-foreground">Não foi possível carregar</h3>
          <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={load}>Tentar novamente</Button>
        </div>
      ) : loading ? (
        <div className="space-y-6">
          <div className="rounded-lg border border-border bg-card p-6 shadow-[var(--shadow-card)]">
            <div className="mb-6 flex items-center justify-between">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-10 rounded-full" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Skeleton className="h-16 w-full sm:col-span-2" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card p-6 shadow-[var(--shadow-card)]">
            <Skeleton className="mb-4 h-5 w-48" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <IntegrationConfigForm
            config={config}
            tenantId={locked}
            externalEnabled={externalEnabled}
            confirm={confirm}
            onSaved={load}
          />
          <BatchHistory tenantId={locked} externalEnabled={externalEnabled} confirm={confirm} />
        </div>
      )}

      {!loading && !error && !config && (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-info/30 bg-info/10 px-4 py-3">
          <Plug className="mt-0.5 h-4 w-4 shrink-0 text-info" />
          <p className="text-sm text-foreground">
            Nenhuma integração configurada ainda. Preencha os campos acima e salve para começar.
          </p>
        </div>
      )}
    </main>
  );
}
