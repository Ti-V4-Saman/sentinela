import * as React from 'react';
import { Loader2, Info } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
// @ts-expect-error — serviço JS sem tipos
import { captureWidCandidates, setCaptureWid } from '../../services/adminApi';

const NONE = '__none__';

export function CaptureWidDialog({
  instance, onClose, onSaved,
}: {
  instance: { id: string; name: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [candidates, setCandidates] = React.useState<string[]>([]);
  const [value, setValue] = React.useState<string>(NONE);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await captureWidCandidates(instance.id);
        if (!alive) return;
        setCandidates(res.candidates || []);
        setValue(res.current || NONE);
      } catch (e) {
        if (alive) setError((e as Error).message || 'Falha ao carregar candidatos');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [instance.id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await setCaptureWid(instance.id, value === NONE ? null : value);
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Não foi possível salvar a ponte de captura.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mapear captura</DialogTitle>
          <DialogDescription>{instance.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
          )}
          <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
            <span>Vincule esta conexão a uma instância de captura (WhatsApp/QuePasa) do mesmo cliente. Enquanto o pipeline não preenche automaticamente, o mapeamento é manual.</span>
          </div>
          <Field label="Instância de captura (wid)" htmlFor="cap-wid">
            {loading ? (
              <div className="flex h-9 items-center px-1 text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando…</div>
            ) : (
              <Select value={value} onValueChange={setValue}>
                <SelectTrigger id="cap-wid" className="w-full font-mono"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Não mapeada</SelectItem>
                  {candidates.map((w) => <SelectItem key={w} value={w} className="font-mono">{w}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving || loading}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
