import * as React from 'react';
import { Loader2, Radio, Info, Unlink, Plus, AlertCircle, AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { listUserInstances, linkUserInstance, unlinkUserInstance, listInstances } from '../../services/adminApi';
import { friendlyError } from '../../utils/validation';

type Inst = { id: string; name: string; phoneNumber?: string; captureMapped?: boolean };
type Toast = { success: (t: string, m?: string) => void; error: (t: string, m?: string) => void };

export function UserInstancesDialog({
  user, toast, onClose,
}: {
  user: { id: number; name: string; tenantId: number };
  toast: Toast;
  onClose: () => void;
}) {
  const [linked, setLinked] = React.useState<Inst[]>([]);
  const [avail, setAvail] = React.useState<Inst[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [toAdd, setToAdd] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [li, allInst] = await Promise.all([listUserInstances(user.id), listInstances()]);
      setLinked(li);
      const linkedIds = new Set(li.map((i: Inst) => i.id));
      setAvail(allInst.filter((i: Inst & { tenantId: number }) =>
        Number(i.tenantId) === Number(user.tenantId) && !linkedIds.has(i.id)));
    } catch (e) {
      setError(friendlyError((e as Error).message) || 'Falha ao carregar as instâncias');
    } finally {
      setLoading(false);
    }
  }, [user.id, user.tenantId]);

  React.useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!toAdd) return;
    setBusy(true);
    try { await linkUserInstance(user.id, toAdd); setToAdd(''); await load(); toast.success('Instância vinculada', 'O usuário passa a acessar as conversas dessa instância (se mapeada).'); }
    catch (e) { toast.error('Não foi possível vincular', friendlyError((e as Error).message)); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true);
    try { await unlinkUserInstance(user.id, id); await load(); toast.success('Instância desvinculada', 'O usuário deixa de acessar as conversas dessa instância.'); }
    catch (e) { toast.error('Não foi possível desvincular', friendlyError((e as Error).message)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Instâncias de {user.name}</DialogTitle>
          <DialogDescription>Vínculo direto (user_instances) — fonte da verdade das conversas do usuário</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive"><AlertCircle className="h-5 w-5" /></div>
            <p className="max-w-xs text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={load}>Tentar novamente</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5" /> Instância sem ponte de captura não libera conversas ao usuário.
            </p>
            <div className="space-y-1.5">
              {linked.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">Nenhuma instância vinculada.</p>
              ) : linked.map((i) => (
                <div key={i.id} className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                  <span className="min-w-0 flex-1 text-sm text-foreground">
                    {i.name} {i.phoneNumber && <span className="font-mono text-xs text-muted-foreground">{i.phoneNumber}</span>}
                  </span>
                  {i.captureMapped
                    ? <StatusBadge tone="success">Mapeada</StatusBadge>
                    : <span className="flex items-center gap-1 text-xs text-warning" title="Sem ponte de captura"><AlertTriangle className="h-3.5 w-3.5" /> Sem captura</span>}
                  <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Desvincular ${i.name}`} disabled={busy} onClick={() => remove(i.id)}>
                    <Unlink className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            {avail.length === 0 ? (
              <p className="text-xs text-muted-foreground">Sem instâncias disponíveis neste cliente.</p>
            ) : (
              <div className="flex gap-2">
                <Select value={toAdd} onValueChange={setToAdd}>
                  <SelectTrigger className="flex-1" aria-label="Adicionar instância"><SelectValue placeholder="Adicionar instância…" /></SelectTrigger>
                  <SelectContent>
                    {avail.map((i) => <SelectItem key={i.id} value={i.id}>{i.name}{i.phoneNumber ? ` (${i.phoneNumber})` : ''}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button onClick={add} disabled={!toAdd || busy}><Plus className="h-4 w-4" /> Vincular</Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
