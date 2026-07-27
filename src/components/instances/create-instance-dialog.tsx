import * as React from 'react';
import { Plus, AlertCircle, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Field } from '@/components/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
// @ts-expect-error — serviço JS sem tipos
import { MANDATORY_WEBHOOK_URL } from '../../services/quepasaApi';

export function CreateInstanceDialog({
  onClose, onCreate,
}: {
  onClose: () => void;
  /** Cria a instância; deve lançar em erro (ex.: número duplicado) para exibir inline. */
  onCreate: (instance: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = React.useState('');
  const [phoneNumber, setPhoneNumber] = React.useState('55');
  const [errors, setErrors] = React.useState<{ name?: string; phone?: string }>({});
  const [formError, setFormError] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const validate = () => {
    const e: { name?: string; phone?: string } = {};
    if (!name.trim()) e.name = 'Campo obrigatório';
    const digits = (phoneNumber || '').replace(/\D/g, '');
    if (!digits) e.phone = 'Campo obrigatório';
    else if (digits.length < 12) e.phone = 'Informe o número com país e DDD, ex: 5531999990000';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError('');
    if (!validate()) return;

    const formattedName = name.trim().toUpperCase().replace(/\s+/g, '-');
    const token = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newInstance = {
      id: `inst-${Date.now()}`,
      name: formattedName,
      token,
      contactName: formattedName,
      phoneNumber: phoneNumber.trim(),
      avatarUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${formattedName}`,
      status: 'Disconnected',
      webhookUrl: MANDATORY_WEBHOOK_URL,
    };

    setSubmitting(true);
    try {
      await onCreate(newInstance);
    } catch (err) {
      setFormError((err as Error).message || 'Não foi possível criar a instância.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova conexão</DialogTitle>
          <DialogDescription>Conecte um número de WhatsApp</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {formError && (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <Field label="Nome / Identificador" htmlFor="inst-name" required error={errors.name}>
            <Input
              id="inst-name" autoFocus value={name}
              onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: '' })); }}
              placeholder="EX: INSTANCIA-VENDAS"
              className="font-mono uppercase"
            />
          </Field>

          <Field
            label="Número de telefone" htmlFor="inst-phone" required
            error={errors.phone}
            hint="Com código do país e DDD. Não é possível abrir duas conexões para o mesmo número."
          >
            <Input
              id="inst-phone" value={phoneNumber}
              onChange={(e) => { setPhoneNumber(e.target.value); if (errors.phone) setErrors((p) => ({ ...p, phone: '' })); }}
              placeholder="5531999990000"
              className="font-mono"
            />
          </Field>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Criar conexão
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
