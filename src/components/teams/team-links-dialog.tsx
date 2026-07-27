import * as React from 'react';
import { Loader2, Radio, Info, Unlink, Plus, User, UserCog, AlertCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  listTeamInstances, listTeamUsers, listTeamManagers,
  linkTeamUser, unlinkTeamUser, linkTeamManager, unlinkTeamManager, listUsers,
} from '../../services/adminApi';
import { friendlyError } from '../../utils/validation';

type Person = { id: number; name: string; email: string; role: string };
type Derived = { id: string; name: string; status: string; ownerUserId: number; ownerName: string };
type Toast = { success: (t: string, m?: string) => void; error: (t: string, m?: string) => void };

export function TeamLinksDialog({
  team, isSuper, toast, onClose,
}: {
  team: { id: number; name: string; tenantId: number };
  isSuper: boolean;
  toast: Toast;
  onClose: () => void;
}) {
  const [derived, setDerived] = React.useState<Derived[]>([]);
  const [members, setMembers] = React.useState<Person[]>([]);
  const [managers, setManagers] = React.useState<Person[]>([]);
  const [availMembers, setAvailMembers] = React.useState<Person[]>([]);
  const [availGestores, setAvailGestores] = React.useState<Person[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [memberToAdd, setMemberToAdd] = React.useState('');
  const [mgrToAdd, setMgrToAdd] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [di, tu, tm, allUsers] = await Promise.all([
        listTeamInstances(team.id), listTeamUsers(team.id), listTeamManagers(team.id),
        listUsers(isSuper ? team.tenantId : undefined),
      ]);
      setDerived(di); setMembers(tu); setManagers(tm);
      const memberIds = new Set(tu.map((u: Person) => u.id));
      setAvailMembers(allUsers.filter((u: Person & { tenantId: number }) =>
        u.role === 'usuario' && Number(u.tenantId) === Number(team.tenantId) && !memberIds.has(u.id)));
      const mgrIds = new Set(tm.map((m: Person) => m.id));
      setAvailGestores(allUsers.filter((u: Person & { tenantId: number }) =>
        u.role === 'gestor' && Number(u.tenantId) === Number(team.tenantId) && !mgrIds.has(u.id)));
    } catch (e) {
      setError(friendlyError((e as Error).message) || 'Falha ao carregar os vínculos');
    } finally {
      setLoading(false);
    }
  }, [team.id, team.tenantId, isSuper]);

  React.useEffect(() => { load(); }, [load]);

  const addMember = async () => {
    if (!memberToAdd) return;
    setBusy(true);
    try { await linkTeamUser(team.id, memberToAdd); setMemberToAdd(''); await load(); toast.success('Usuário vinculado', 'Membro adicionado; os números dele entram na equipe.'); }
    catch (e) { toast.error('Não foi possível vincular', friendlyError((e as Error).message)); }
    finally { setBusy(false); }
  };
  const removeMember = async (id: number) => {
    setBusy(true);
    try { await unlinkTeamUser(team.id, id); await load(); toast.success('Usuário desvinculado', 'Membro removido; os números dele saem da equipe.'); }
    catch (e) { toast.error('Não foi possível desvincular', friendlyError((e as Error).message)); }
    finally { setBusy(false); }
  };
  const addManager = async () => {
    if (!mgrToAdd) return;
    setBusy(true);
    try { await linkTeamManager(team.id, mgrToAdd); setMgrToAdd(''); await load(); toast.success('Gestor vinculado', 'Gestor adicionado à equipe.'); }
    catch (e) { toast.error('Não foi possível vincular', friendlyError((e as Error).message)); }
    finally { setBusy(false); }
  };
  const removeManager = async (id: number) => {
    setBusy(true);
    try { await unlinkTeamManager(team.id, id); await load(); toast.success('Gestor desvinculado', 'Gestor removido da equipe.'); }
    catch (e) { toast.error('Não foi possível desvincular', friendlyError((e as Error).message)); }
    finally { setBusy(false); }
  };

  const linkList = (
    people: Person[], emptyLabel: string, onRemove: (id: number) => void,
  ) => (
    <div className="space-y-1.5">
      {people.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{emptyLabel}</p>
      ) : people.map((p) => (
        <div key={p.id} className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
          <span className="min-w-0 text-sm text-foreground">
            {p.name} <span className="font-mono text-xs text-muted-foreground">{p.email}</span>
          </span>
          <Button
            variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`Desvincular ${p.name}`} disabled={busy} onClick={() => onRemove(p.id)}
          >
            <Unlink className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );

  const addRow = (
    value: string, setValue: (v: string) => void, avail: Person[], onAdd: () => void, kind: string,
  ) => (
    avail.length === 0 ? (
      <p className="mt-3 text-xs text-muted-foreground">
        Sem {kind} disponíveis neste cliente. Crie-os na tela de Usuários.
      </p>
    ) : (
      <div className="mt-3 flex gap-2">
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger className="flex-1" aria-label={`Adicionar ${kind}`}>
            <SelectValue placeholder={`Adicionar ${kind}…`} />
          </SelectTrigger>
          <SelectContent>
            {avail.map((u) => <SelectItem key={u.id} value={String(u.id)}>{u.name} ({u.email})</SelectItem>)}
          </SelectContent>
        </Select>
        <Button onClick={onAdd} disabled={!value || busy}>
          <Plus className="h-4 w-4" /> Vincular
        </Button>
      </div>
    )
  );

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Equipe: {team.name}</DialogTitle>
          <DialogDescription>Membros, gestores e números derivados</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertCircle className="h-5 w-5" />
            </div>
            <p className="max-w-xs text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={load}>Tentar novamente</Button>
          </div>
        ) : (
          <Tabs defaultValue="members" className="gap-4">
            <TabsList className="w-full">
              <TabsTrigger value="members"><User className="h-4 w-4" /> Membros ({members.length})</TabsTrigger>
              <TabsTrigger value="managers"><UserCog className="h-4 w-4" /> Gestores ({managers.length})</TabsTrigger>
              <TabsTrigger value="numbers"><Radio className="h-4 w-4" /> Números ({derived.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="members">
              {linkList(members, 'Nenhum usuário vinculado.', removeMember)}
              {addRow(memberToAdd, setMemberToAdd, availMembers, addMember, 'usuário')}
            </TabsContent>

            <TabsContent value="managers">
              {linkList(managers, 'Nenhum gestor vinculado.', removeManager)}
              {addRow(mgrToAdd, setMgrToAdd, availGestores, addManager, 'gestor')}
            </TabsContent>

            <TabsContent value="numbers">
              <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5" /> Automático — vêm dos usuários vinculados como membros.
              </p>
              <div className="space-y-1.5">
                {derived.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                    Nenhum número — vincule usuários na aba Membros.
                  </p>
                ) : derived.map((i) => (
                  <div key={i.id} className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
                    <span className="min-w-0 text-sm text-foreground">
                      {i.name} <span className="text-xs text-muted-foreground">· dono: {i.ownerName}</span>
                    </span>
                    <StatusBadge tone={i.status === 'Connected' ? 'success' : 'neutral'}>
                      {i.status === 'Connected' ? 'Conectada' : 'Desconectada'}
                    </StatusBadge>
                  </div>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
