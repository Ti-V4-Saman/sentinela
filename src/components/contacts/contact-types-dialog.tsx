import * as React from 'react';
import { Loader2, Plus, Pencil, Trash2, Tag, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Field } from '@/components/field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ContactTypeBadge, type ContactType } from './contact-type-badge';
import { listContactTypes, createContactType, updateContactType, deleteContactType } from '../../services/adminApi';
import { friendlyError } from '../../utils/validation';

type TypeRow = ContactType & { contactCount: number };

const COLORS = ['neutral', 'info', 'ia', 'success', 'warning', 'alert', 'destructive'];
const COLOR_LABEL: Record<string, string> = {
  neutral: 'Neutro', info: 'Informação', ia: 'IA', success: 'Sucesso', warning: 'Atenção', alert: 'Alerta', destructive: 'Crítico',
};

export function ContactTypesDialog({
  isSuper, tenantId, toast, onClose,
}: {
  isSuper: boolean;
  tenantId?: number | null;
  toast: { success: (t: string, d?: string) => void; error: (t: string, d?: string) => void };
  onClose: () => void;
}) {
  const [types, setTypes] = React.useState<TypeRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState('info');
  const [editing, setEditing] = React.useState<TypeRow | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    try { setTypes(await listContactTypes(isSuper ? tenantId || undefined : undefined)); }
    catch (e) { toast.error('Não foi possível carregar', friendlyError((e as Error).message)); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuper, tenantId]);

  React.useEffect(() => { load(); }, [load]);

  const resetForm = () => { setEditing(null); setName(''); setColor('info'); setError(''); };
  const startEdit = (t: TypeRow) => { setEditing(t); setName(t.name); setColor(t.color || 'neutral'); setError(''); };

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError('');
    if (!name.trim()) { setError('Informe um nome.'); return; }
    setSaving(true);
    try {
      if (editing) {
        await updateContactType(editing.id, { name: name.trim(), color });
        toast.success('Tipo atualizado', name.trim());
      } else {
        const body: Record<string, unknown> = { name: name.trim(), color };
        if (isSuper) body.tenantId = tenantId;
        await createContactType(body);
        toast.success('Tipo criado', name.trim());
      }
      resetForm();
      await load();
    } catch (e) {
      setError(friendlyError((e as Error).message) || 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (t: TypeRow) => {
    try {
      await deleteContactType(t.id);
      toast.success('Tipo removido', `"${t.name}" foi excluído${t.contactCount ? ` e ${t.contactCount} contato(s) desvinculado(s)` : ''}.`);
      if (editing?.id === t.id) resetForm();
      await load();
    } catch (e) {
      toast.error('Não foi possível remover', friendlyError((e as Error).message));
    }
  };

  const disabled = isSuper && !tenantId;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tipos de contato</DialogTitle>
          <DialogDescription>Categorias usadas na identificação (ex.: Lead, Cliente, Fornecedor).</DialogDescription>
        </DialogHeader>

        {disabled ? (
          <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            Selecione um cliente na tela para gerenciar seus tipos.
          </p>
        ) : (
          <>
            <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field label="Nome" htmlFor="ctype-name" className="flex-1" error={error}>
                <Input id="ctype-name" value={name} onChange={(e) => { setName(e.target.value); if (error) setError(''); }} placeholder="Ex.: Cliente" />
              </Field>
              <Field label="Cor" htmlFor="ctype-color" className="sm:w-[160px]">
                <Select value={color} onValueChange={setColor}>
                  <SelectTrigger id="ctype-color" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {COLORS.map((c) => (
                      <SelectItem key={c} value={c}>
                        <span className="inline-flex items-center gap-2">
                          <ContactTypeBadge type={{ id: 0, name: COLOR_LABEL[c], color: c }} />
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="flex gap-2">
                {editing && (
                  <Button type="button" variant="ghost" size="icon" onClick={resetForm} aria-label="Cancelar edição"><X className="h-4 w-4" /></Button>
                )}
                <Button type="submit" disabled={saving}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (editing ? <Pencil className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />)}
                  {editing ? 'Salvar' : 'Adicionar'}
                </Button>
              </div>
            </form>

            <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
              ) : types.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-6 text-center text-muted-foreground">
                  <Tag className="h-6 w-6" />
                  <p className="text-sm">Nenhum tipo ainda. Crie o primeiro acima.</p>
                </div>
              ) : (
                types.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <ContactTypeBadge type={t} />
                      <span className="text-xs text-muted-foreground">{t.contactCount} contato(s)</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" onClick={() => startEdit(t)} aria-label={`Editar ${t.name}`}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => remove(t)} aria-label={`Excluir ${t.name}`}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
