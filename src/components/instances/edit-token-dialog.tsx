import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function EditTokenDialog({
  instance,
  onClose,
  onSave,
}: {
  instance: { id: string; name: string; token?: string };
  onClose: () => void;
  onSave: (id: string, token: string) => Promise<void> | void;
}) {
  const [token, setToken] = React.useState(instance.token || '');
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) { setError('Informe o token da conexão'); return; }
    setSaving(true);
    try {
      await onSave(instance.id, token.trim());
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Não foi possível salvar o token.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar token da conexão</DialogTitle>
          <DialogDescription>{instance.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Token do QuePasa" htmlFor="conn-token" required error={error}>
            <Input
              id="conn-token"
              value={token}
              onChange={(e) => { setToken(e.target.value); if (error) setError(''); }}
              placeholder="Cole o token UUID"
              className="font-mono"
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
