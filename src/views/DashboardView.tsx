import * as React from 'react';
import {
  MessageSquare, MessagesSquare, ArrowDownLeft, ArrowUpRight, Contact, Loader2, AlertCircle,
} from 'lucide-react';
import { LineChart, BarChart, type BarDatum } from '@/components/charts';
import { PeriodControls, defaultRange, type TenantOption } from '@/components/reports/period-controls';
import { reportSummary, reportDaily, reportMediaTypes, listTenants } from '../services/adminApi';
import { getUser } from '../services/authApi';
import { friendlyError } from '../utils/validation';

const MEDIA_TONE: Record<string, string> = { text: 'primary', audio: 'info', image: 'ia', video: 'warning', document: 'success' };

function Kpi({ icon: Icon, label, value, tone }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number | string; tone: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-[var(--shadow-card)]">
      <span className={`flex h-9 w-9 items-center justify-center rounded-md ${tone}`}><Icon className="h-5 w-5" /></span>
      <span className="min-w-0">
        <span className="block text-lg font-semibold text-foreground">{value}</span>
        <span className="block truncate text-xs text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

export default function DashboardView({ tenantId: locked }: { tenantId?: number }) {
  const me = getUser();
  // No modo cliente (locked definido) o escopo é fixo e o seletor de cliente some.
  const isSuper = me?.role === 'superadmin' && locked == null;
  const init = React.useMemo(() => defaultRange(), []);
  const [from, setFrom] = React.useState(init.from);
  const [to, setTo] = React.useState(init.to);
  const [tenantId, setTenantId] = React.useState('ALL');
  const [tenants, setTenants] = React.useState<TenantOption[]>([]);

  const [summary, setSummary] = React.useState<any>(null);
  const [daily, setDaily] = React.useState<{ date: string; received: number; sent: number }[]>([]);
  const [media, setMedia] = React.useState<{ type: string; total: number }[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  React.useEffect(() => { if (isSuper) listTenants().then(setTenants).catch(() => {}); }, [isSuper]);

  const params = React.useMemo(() => ({ from, to, tenant_id: locked != null ? locked : (isSuper && tenantId !== 'ALL' ? tenantId : undefined) }), [from, to, isSuper, tenantId, locked]);

  React.useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    Promise.all([reportSummary(params), reportDaily(params), reportMediaTypes(params)])
      .then(([s, d, m]) => { if (!alive) return; setSummary(s); setDaily(d.daily); setMedia(m.items); })
      .catch((e: Error) => { if (alive) setError(friendlyError(e.message) || 'Falha ao carregar o painel'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [params]);

  const mediaData: BarDatum[] = media.map((m) => ({ label: m.type, value: m.total, tone: MEDIA_TONE[m.type] || 'neutral' }));

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 lg:px-8">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">Painel</h1>
          <p className="text-sm text-muted-foreground">Visão executiva do período · somente leitura</p>
        </div>
        <PeriodControls from={from} to={to} onFrom={setFrom} onTo={setTo} isSuper={isSuper} tenantId={tenantId} onTenant={setTenantId} tenants={tenants} />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : error ? (
        <div className="flex flex-col items-center gap-2 py-20 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"><AlertCircle className="h-6 w-6" /></div>
          <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
        </div>
      ) : summary ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Kpi icon={ArrowDownLeft} label="Recebidas" value={summary.messages.received} tone="bg-info/10 text-info" />
            <Kpi icon={ArrowUpRight} label="Enviadas" value={summary.messages.sent} tone="bg-success/10 text-success" />
            <Kpi icon={MessageSquare} label="Conversas" value={summary.conversations} tone="bg-muted text-muted-foreground" />
            <Kpi icon={MessagesSquare} label="Grupos" value={summary.groups} tone="bg-muted text-muted-foreground" />
            <Kpi icon={Contact} label="Identificados" value={summary.contacts.identified} tone="bg-success/10 text-success" />
            <Kpi icon={Contact} label="Pendentes" value={summary.contacts.pending} tone="bg-warning/10 text-warning" />
          </div>

          <section className="rounded-lg border border-border bg-card p-4 shadow-[var(--shadow-card)]">
            <h2 className="mb-3 font-heading text-base font-semibold text-foreground">Evolução diária</h2>
            <LineChart
              labels={daily.map((d) => d.date)}
              series={[
                { name: 'Recebidas', tone: 'info', points: daily.map((d) => d.received) },
                { name: 'Enviadas', tone: 'success', points: daily.map((d) => d.sent) },
              ]}
            />
          </section>

          <section className="rounded-lg border border-border bg-card p-4 shadow-[var(--shadow-card)]">
            <h2 className="mb-3 font-heading text-base font-semibold text-foreground">Tipos de mídia</h2>
            <BarChart data={mediaData} />
          </section>
        </div>
      ) : null}
    </main>
  );
}
