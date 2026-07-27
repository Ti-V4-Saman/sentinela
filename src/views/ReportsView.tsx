import * as React from 'react';
import { Download, Loader2, AlertCircle, Radio, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BarChart, type BarDatum } from '@/components/charts';
import { PeriodControls, defaultRange, type TenantOption } from '@/components/reports/period-controls';
import { reportByInstance, reportByTeam, downloadReportCsv, listTenants } from '../services/adminApi';
import { getUser } from '../services/authApi';
import { useToast } from '../components/ui/ToastProvider';
import { friendlyError } from '../utils/validation';

type VolumeItem = { name: string; received: number; sent: number; total: number };

function VolumeSection({ title, icon: Icon, items, loading, error, onExport, exporting }: {
  title: string; icon: React.ComponentType<{ className?: string }>; items: VolumeItem[];
  loading: boolean; error: string; onExport: () => void; exporting: boolean;
}) {
  const data: BarDatum[] = items.map((i) => ({ label: i.name, value: i.total, tone: 'primary' }));
  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-[var(--shadow-card)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="inline-flex items-center gap-2 font-heading text-base font-semibold text-foreground"><Icon className="h-4 w-4 text-muted-foreground" /> {title}</h2>
        <Button variant="outline" size="sm" onClick={onExport} disabled={exporting || loading || !!error}>
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} CSV
        </Button>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : error ? (
        <div className="flex flex-col items-center gap-1 py-10 text-center text-muted-foreground"><AlertCircle className="h-6 w-6 text-destructive" /><span className="text-sm">{error}</span></div>
      ) : (
        <BarChart data={data} />
      )}
    </section>
  );
}

export default function ReportsView({ tenantId: locked }: { tenantId?: number }) {
  const me = getUser();
  const isSuper = me?.role === 'superadmin' && locked == null;
  const toast = useToast();
  const init = React.useMemo(() => defaultRange(), []);
  const [from, setFrom] = React.useState(init.from);
  const [to, setTo] = React.useState(init.to);
  const [tenantId, setTenantId] = React.useState('ALL');
  const [tenants, setTenants] = React.useState<TenantOption[]>([]);

  const [byInstance, setByInstance] = React.useState<VolumeItem[]>([]);
  const [byTeam, setByTeam] = React.useState<VolumeItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [exporting, setExporting] = React.useState('');

  React.useEffect(() => { if (isSuper) listTenants().then(setTenants).catch(() => {}); }, [isSuper]);

  const scopeTid = locked != null ? locked : (isSuper && tenantId !== 'ALL' ? tenantId : undefined);
  const params = React.useMemo(() => ({ from, to, tenant_id: scopeTid, limit: 100 }), [from, to, scopeTid]);

  React.useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    Promise.all([reportByInstance(params), reportByTeam(params)])
      .then(([i, t]) => { if (!alive) return; setByInstance(i.items); setByTeam(t.items); })
      .catch((e: Error) => { if (alive) setError(friendlyError(e.message) || 'Falha ao carregar os relatórios'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [params]);

  const exportCsv = async (type: string) => {
    setExporting(type);
    try {
      const { blob, filename } = await downloadReportCsv({ type, from, to, tenant_id: scopeTid });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
      toast.success('Exportado', `${filename} baixado.`);
    } catch (e) {
      toast.error('Falha ao exportar', friendlyError((e as Error).message));
    } finally {
      setExporting('');
    }
  };

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 lg:px-8">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">Relatórios</h1>
          <p className="text-sm text-muted-foreground">Volume por instância e equipe · exportação CSV</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PeriodControls from={from} to={to} onFrom={setFrom} onTo={setTo} isSuper={isSuper} tenantId={tenantId} onTenant={setTenantId} tenants={tenants} />
          <Button variant="outline" size="sm" onClick={() => exportCsv('daily')} disabled={!!exporting}>
            {exporting === 'daily' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Evolução diária (CSV)
          </Button>
        </div>
      </div>

      <div className="space-y-6">
        <VolumeSection title="Volume por instância" icon={Radio} items={byInstance} loading={loading} error={error}
          onExport={() => exportCsv('by-instance')} exporting={exporting === 'by-instance'} />
        <VolumeSection title="Volume por equipe" icon={UsersRound} items={byTeam} loading={loading} error={error}
          onExport={() => exportCsv('by-team')} exporting={exporting === 'by-team'} />
      </div>
    </main>
  );
}
