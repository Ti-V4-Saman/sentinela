import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type ClientTenant = { id: number; name: string; status?: string };

export function ClientFormDialog({
  initial,
  onClose,
  onSubmit,
}: {
  /** Presente = edição; ausente/null = criação. */
  initial?: ClientTenant | null;
  onClose: () => void;
  /** Cria (só name) ou edita (name + status). Deve lançar em erro para exibir inline. */
  onSubmit: (values: { name: string; status?: string }, editing: boolean) => Promise<void>;
}) {
  const editing = !!initial;
  const [name, setName] = React.useState(initial?.name || '');
  const [status, setStatus] = React.useState(initial?.status || 'active');
  const [nameErr, setNameErr] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setNameErr('Campo obrigatório'); return; }
    setSaving(true);
    try {
      await onSubmit(editing ? { name: name.trim(), status } : { name: name.trim() }, editing);
      onClose();
    } catch (err) {
      setNameErr((err as Error).message || 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar cliente' : 'Novo cliente'}</DialogTitle>
          <DialogDescription>
            {editing ? initial!.name : 'Clientes isolam dados entre si (multi-tenant).'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Nome do cliente" htmlFor="client-name" required error={nameErr}>
            <Input
              id="client-name"
              autoFocus
              value={name}
              onChange={(e) => { setName(e.target.value); if (nameErr) setNameErr(''); }}
              placeholder="Ex.: Clínica Vitalis"
            />
          </Field>

          {editing && (
            <Field label="Status" htmlFor="client-status">
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="client-status" className="w-full">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Ativo</SelectItem>
                  <SelectItem value="suspended">Suspenso</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {editing ? 'Salvar' : 'Criar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
