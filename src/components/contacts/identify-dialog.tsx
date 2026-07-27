import * as React from 'react';
import { Loader2, UserRoundCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ContactTypeBadge, type ContactType } from './contact-type-badge';

export type ContactRow = {
  id: string;
  tenantId?: number;
  name: string | null;
  displayName: string | null;
  phone: string | null;
  identified: boolean;
  identificationSource?: string | null;
  type: ContactType | null;
  linkedUser: { id: number; name: string | null } | null;
};

export type UserOption = { id: number; name: string };

const NONE = 'NONE';

export function IdentifyDialog({
  contact, types, users, onClose, onSubmit, onClear,
}: {
  contact: ContactRow;
  types: ContactType[];
  users: UserOption[];
  onClose: () => void;
  // Deve lançar em erro para exibir inline.
  onSubmit: (body: { displayName: string | null; contactTypeId: number | null; linkedUserId: number | null; tenantId?: number }) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = React.useState(contact.displayName || '');
  const [typeId, setTypeId] = React.useState<string>(contact.type ? String(contact.type.id) : NONE);
  const [userId, setUserId] = React.useState<string>(contact.linkedUser ? String(contact.linkedUser.id) : NONE);
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);

  const nothing = !displayName.trim() && typeId === NONE && userId === NONE;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError('');
    if (nothing) { setError('Informe ao menos um nome de exibição, tipo ou usuário vinculado.'); return; }
    setSaving(true);
    try {
      await onSubmit({
        displayName: displayName.trim() || null,
        contactTypeId: typeId === NONE ? null : Number(typeId),
        linkedUserId: userId === NONE ? null : Number(userId),
        ...(contact.tenantId ? { tenantId: contact.tenantId } : {}),
      });
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setError(''); setClearing(true);
    try { await onClear(); onClose(); }
    catch (err) { setError((err as Error).message || 'Não foi possível remover.'); }
    finally { setClearing(false); }
  };

  const original = contact.name || contact.phone || contact.id;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Identificar contato</DialogTitle>
          <DialogDescription>
            Contato original: <span className="font-medium text-foreground">{original}</span>
            {contact.phone && <span className="text-muted-foreground"> · {contact.phone}</span>}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Nome de exibição" htmlFor="ident-name">
            <Input
              id="ident-name" autoFocus value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ex.: Ana Silva (Financeiro)"
            />
          </Field>

          <Field label="Tipo" htmlFor="ident-type">
            <Select value={typeId} onValueChange={setTypeId}>
              <SelectTrigger id="ident-type" className="w-full"><SelectValue placeholder="Sem tipo" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sem tipo</SelectItem>
                {types.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    <span className="inline-flex items-center gap-2"><ContactTypeBadge type={t} /></span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Usuário vinculado" htmlFor="ident-user" hint="Associe este contato a um usuário do sistema (opcional).">
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger id="ident-user" className="w-full"><SelectValue placeholder="Nenhum" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Nenhum</SelectItem>
                {users.map((u) => <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter className="items-center justify-between sm:justify-between">
            {contact.identified ? (
              <Button type="button" variant="ghost" onClick={clear} disabled={clearing || saving}>
                {clearing && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Remover identificação
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
              <Button type="submit" disabled={saving || clearing}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserRoundCheck className="h-3.5 w-3.5" />} Salvar
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
