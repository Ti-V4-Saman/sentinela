import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type TeamRow = { id: number; name: string; tenantId?: number | null };
export type TenantOption = { id: number; name: string };

export function TeamFormDialog({
  initial, isSuper, tenants, onClose, onSubmit,
}: {
  initial?: TeamRow | null;
  isSuper: boolean;
  tenants: TenantOption[];
  onClose: () => void;
  /** Cria (name + tenantId p/ super) ou edita (só name). Deve lançar em erro para exibir inline. */
  onSubmit: (body: { name: string; tenantId?: number }, editing: boolean) => Promise<void>;
}) {
  const editing = !!initial;
  const [name, setName] = React.useState(initial?.name || '');
  const [tenantId, setTenantId] = React.useState<string>(initial?.tenantId != null ? String(initial.tenantId) : '');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const needsTenant = isSuper && !editing;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Campo obrigatório';
    if (needsTenant && !tenantId) e.tenantId = 'Selecione um cliente';
    setErrors(e);
    if (Object.keys(e).length) return;

    setSaving(true);
    try {
      const body = needsTenant ? { name: name.trim(), tenantId: Number(tenantId) } : { name: name.trim() };
      await onSubmit(body, editing);
      onClose();
    } catch (err) {
      setErrors((p) => ({ ...p, name: (err as Error).message || 'Não foi possível salvar.' }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar equipe' : 'Nova equipe'}</DialogTitle>
          <DialogDescription>
            {editing ? initial!.name : 'Equipes agrupam usuários; os números vêm dos usuários vinculados.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Nome da equipe" htmlFor="team-name" required error={errors.name}>
            <Input
              id="team-name" autoFocus value={name}
              onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: '' })); }}
              placeholder="Ex.: Comercial SP"
            />
          </Field>

          {needsTenant && (
            <Field label="Cliente" htmlFor="team-tenant" required error={errors.tenantId}>
              <Select value={tenantId} onValueChange={(v) => { setTenantId(v); if (errors.tenantId) setErrors((p) => ({ ...p, tenantId: '' })); }}>
                <SelectTrigger id="team-tenant" className="w-full"><SelectValue placeholder="Selecione…" /></SelectTrigger>
                <SelectContent>
                  {tenants.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
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
