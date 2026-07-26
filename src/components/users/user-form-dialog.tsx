import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { validateFullName, validateEmail } from '../../utils/validation';

export const ROLE_LABELS: Record<string, string> = {
  superadmin: 'Superadmin', admin: 'Administrador', gestor: 'Gestor', usuario: 'Usuário',
};

export type UserRow = {
  id: number; name: string; email: string; role: string; status: string; tenantId?: number | null;
};
export type TenantOption = { id: number; name: string };

type Confirm = (o: {
  title: string; description?: string; variant?: 'danger' | 'warning'; confirmLabel?: string;
}) => Promise<boolean>;

export function UserFormDialog({
  initial, isSuper, tenants, defaultTenantId, confirm, onClose, onSubmit,
}: {
  initial?: UserRow | null;
  isSuper: boolean;
  tenants: TenantOption[];
  defaultTenantId?: number | string;
  confirm: Confirm;
  onClose: () => void;
  /** Cria/edita: recebe o body pronto e um flag `editing`. Deve lançar em erro para exibir inline. */
  onSubmit: (body: Record<string, unknown>, editing: boolean) => Promise<void>;
}) {
  const editing = !!initial;
  const [name, setName] = React.useState(initial?.name || '');
  const [email, setEmail] = React.useState(initial?.email || '');
  const [password, setPassword] = React.useState('');
  const [role, setRole] = React.useState(initial?.role || 'usuario');
  const [status, setStatus] = React.useState(initial?.status || 'active');
  const [tenantId, setTenantId] = React.useState<string>(
    initial?.tenantId != null ? String(initial.tenantId) : (defaultTenantId != null ? String(defaultTenantId) : ''),
  );
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const roleOptions = isSuper ? ['superadmin', 'admin', 'gestor', 'usuario'] : ['admin', 'gestor', 'usuario'];
  const needsTenant = isSuper && role !== 'superadmin';

  const validate = () => {
    const e: Record<string, string> = {};
    const nErr = validateFullName(name); if (nErr) e.name = nErr;
    const eErr = validateEmail(email); if (eErr) e.email = eErr;
    if (!editing && !password) e.password = 'Campo obrigatório';
    else if (password && password.length < 8) e.password = 'A senha precisa ter no mínimo 8 caracteres';
    if (needsTenant && !editing && !tenantId) e.tenantId = 'Selecione um cliente';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!validate()) return;

    // Troca de papel é sensível: confirma nomeando a mudança.
    if (editing && role !== initial!.role) {
      const ok = await confirm({
        title: 'Alterar papel do usuário?',
        description: `Você está mudando o papel de ${initial!.name} de ${ROLE_LABELS[initial!.role]} para ${ROLE_LABELS[role]}. Isso altera o nível de acesso dele.`,
        variant: 'warning',
        confirmLabel: 'Alterar papel',
      });
      if (!ok) return;
    }

    setSaving(true);
    try {
      if (editing) {
        const body: Record<string, unknown> = { name, email, role, status };
        if (password) body.password = password;
        await onSubmit(body, true);
      } else {
        const body: Record<string, unknown> = { name, email, password, role };
        if (needsTenant) body.tenantId = Number(tenantId);
        await onSubmit(body, false);
      }
      onClose();
    } catch (err) {
      setErrors((prev) => ({ ...prev, form: (err as Error).message || 'Não foi possível salvar.' }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar usuário' : 'Novo usuário'}</DialogTitle>
          <DialogDescription>
            {editing ? initial!.email : (isSuper ? 'Usuário de um cliente ou superadmin global.' : 'Usuário do seu cliente.')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {errors.form && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {errors.form}
            </div>
          )}

          <Field label="Nome completo" htmlFor="user-name" required error={errors.name}>
            <Input
              id="user-name" autoFocus value={name}
              onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: '' })); }}
              placeholder="Ex.: Maria Silva"
            />
          </Field>

          <Field label="E-mail" htmlFor="user-email" required error={errors.email}>
            <Input
              id="user-email" type="email" value={email}
              onChange={(e) => { setEmail(e.target.value); if (errors.email) setErrors((p) => ({ ...p, email: '' })); }}
              placeholder="voce@empresa.com"
            />
          </Field>

          <Field
            label="Senha" htmlFor="user-password" required={!editing}
            error={errors.password}
            hint={editing ? 'Deixe em branco para manter a senha atual.' : 'Mínimo de 8 caracteres.'}
          >
            <Input
              id="user-password" type="password" autoComplete="new-password" value={password}
              onChange={(e) => { setPassword(e.target.value); if (errors.password) setErrors((p) => ({ ...p, password: '' })); }}
              placeholder={editing ? '••••••••' : ''}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Papel" htmlFor="user-role" required>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="user-role" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>

            {editing && (
              <Field label="Status" htmlFor="user-status">
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger id="user-status" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Ativo</SelectItem>
                    <SelectItem value="disabled">Desativado</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>

          {needsTenant && !editing && (
            <Field label="Cliente" htmlFor="user-tenant" required error={errors.tenantId}>
              <Select value={tenantId} onValueChange={(v) => { setTenantId(v); if (errors.tenantId) setErrors((p) => ({ ...p, tenantId: '' })); }}>
                <SelectTrigger id="user-tenant" className="w-full"><SelectValue placeholder="Selecione…" /></SelectTrigger>
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
