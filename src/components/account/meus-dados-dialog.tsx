import * as React from 'react';
import { Loader2, Lock } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { updateProfile } from '../../services/adminApi';
import { getUser, updateStoredUser } from '../../services/authApi';
import { validateFullName, validatePassword, friendlyError } from '../../utils/validation';
import { useToast } from '../ui/ToastProvider';

export function MeusDadosDialog({
  onClose, onUpdated,
}: {
  onClose: () => void;
  onUpdated?: (updated: { name: string }) => void;
}) {
  const me = getUser();
  const toast = useToast();
  const [name, setName] = React.useState(me?.name || '');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const validate = () => {
    const e: Record<string, string> = {};
    const nameErr = validateFullName(name);
    if (nameErr) e.name = nameErr;
    if (password) {
      const pErr = validatePassword(password);
      if (pErr) e.password = pErr;
      if (!confirm) e.confirm = 'Confirme a nova senha';
      else if (confirm !== password) e.confirm = 'As senhas não coincidem';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      const body: { name: string; password?: string } = { name: name.trim() };
      if (password) body.password = password;
      const updated = await updateProfile(body);
      updateStoredUser({ name: updated.name });
      onUpdated?.({ name: updated.name });
      toast.success(
        'Perfil atualizado',
        password ? 'Seu nome e senha foram atualizados com sucesso.' : 'Seu nome foi atualizado com sucesso.',
      );
      onClose();
    } catch (err) {
      toast.error('Não foi possível salvar', friendlyError((err as Error).message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Meus dados</DialogTitle>
          <DialogDescription>Edite seu nome e senha de acesso.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Nome completo" htmlFor="me-name" required error={errors.name}>
            <Input
              id="me-name" autoFocus value={name}
              onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: '' })); }}
            />
          </Field>

          <Field label="E-mail (login)" htmlFor="me-email" hint="O e-mail de login não pode ser alterado por aqui.">
            <div className="relative">
              <Input id="me-email" value={me?.email || ''} disabled className="pr-9" />
              <Lock className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
          </Field>

          <Separator />
          <p className="text-xs text-muted-foreground">Deixe os campos de senha em branco para manter a senha atual.</p>

          <Field label="Nova senha" htmlFor="me-password" error={errors.password}>
            <Input
              id="me-password" type="password" autoComplete="new-password" value={password}
              onChange={(e) => { setPassword(e.target.value); if (errors.password) setErrors((p) => ({ ...p, password: '' })); }}
            />
          </Field>

          <Field label="Confirmar nova senha" htmlFor="me-confirm" error={errors.confirm}>
            <Input
              id="me-confirm" type="password" autoComplete="new-password" value={confirm}
              onChange={(e) => { setConfirm(e.target.value); if (errors.confirm) setErrors((p) => ({ ...p, confirm: '' })); }}
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
