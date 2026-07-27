import * as React from 'react';
import { Loader2, Radio, Info, Unlink, Plus, User, UserCog, AlertCircle, AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  listTeamInstances, linkTeamInstance, unlinkTeamInstance,
  listTeamUsers, listTeamManagers, linkTeamUser, unlinkTeamUser,
  linkTeamManager, unlinkTeamManager, listUsers, listInstances,
} from '../../services/adminApi';
import { friendlyError } from '../../utils/validation';

type Person = { id: number; name: string; email: string; role: string };
type Inst = { id: string; name: string; phoneNumber?: string; status?: string; captureMapped?: boolean };
type Toast = { success: (t: string, m?: string) => void; error: (t: string, m?: string) => void };

export function TeamLinksDialog({
  team, isSuper, toast, onClose,
}: {
  team: { id: number; name: string; tenantId: number };
  isSuper: boolean;
  toast: Toast;
  onClose: () => void;
}) {
  const [instances, setInstances] = React.useState<Inst[]>([]);
  const [availInstances, setAvailInstances] = React.useState<Inst[]>([]);
  const [members, setMembers] = React.useState<Person[]>([]);
  const [managers, setManagers] = React.useState<Person[]>([]);
  const [availMembers, setAvailMembers] = React.useState<Person[]>([]);
  const [availGestores, setAvailGestores] = React.useState<Person[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [instToAdd, setInstToAdd] = React.useState('');
  const [memberToAdd, setMemberToAdd] = React.useState('');
  const [mgrToAdd, setMgrToAdd] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [ti, tu, tm, allUsers, allInst] = await Promise.all([
        listTeamInstances(team.id), listTeamUsers(team.id), listTeamManagers(team.id),
        listUsers(isSuper ? team.tenantId : undefined), listInstances(),
      ]);
      setInstances(ti); setMembers(tu); setManagers(tm);
      const linkedIds = new Set(ti.map((i: Inst) => i.id));
      setAvailInstances(allInst.filter((i: Inst & { tenantId: number }) =>
        Number(i.tenantId) === Number(team.tenantId) && !linkedIds.has(i.id)));
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

  const run = async (fn: () => Promise<unknown>, okTitle: string, okMsg: string, errTitle: string) => {
    setBusy(true);
    try { await fn(); await load(); toast.success(okTitle, okMsg); }
    catch (e) { toast.error(errTitle, friendlyError((e as Error).message)); }
    finally { setBusy(false); }
  };

  const addInstance = () => instToAdd && run(() => linkTeamInstance(team.id, instToAdd).then(() => setInstToAdd('')),
    'Instância vinculada', 'A equipe passa a acessar as conversas dessa instância (se mapeada).', 'Não foi possível vincular');
  const removeInstance = (id: string) => run(() => unlinkTeamInstance(team.id, id),
    'Instância desvinculada', 'A equipe deixa de acessar as conversas dessa instância.', 'Não foi possível desvincular');
  const addMember = () => memberToAdd && run(() => linkTeamUser(team.id, memberToAdd).then(() => setMemberToAdd('')),
    'Usuário vinculado', 'Membro adicionado à equipe.', 'Não foi possível vincular');
  const removeMember = (id: number) => run(() => unlinkTeamUser(team.id, id), 'Usuário desvinculado', 'Membro removido.', 'Não foi possível desvincular');
  const addManager = () => mgrToAdd && run(() => linkTeamManager(team.id, mgrToAdd).then(() => setMgrToAdd('')),
    'Gestor vinculado', 'Gestor adicionado à equipe.', 'Não foi possível vincular');
  const removeManager = (id: number) => run(() => unlinkTeamManager(team.id, id), 'Gestor desvinculado', 'Gestor removido.', 'Não foi possível desvincular');

  const personList = (people: Person[], emptyLabel: string, onRemove: (id: number) => void) => (
    <div className="space-y-1.5">
      {people.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{emptyLabel}</p>
      ) : people.map((p) => (
        <div key={p.id} className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
          <span className="min-w-0 text-sm text-foreground">{p.name} <span className="font-mono text-xs text-muted-foreground">{p.email}</span></span>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`Desvincular ${p.name}`} disabled={busy} onClick={() => onRemove(p.id)}>
            <Unlink className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );

  const addRow = (value: string, setValue: (v: string) => void, avail: { id: string | number; label: string }[], onAdd: () => void, kind: string) => (
    avail.length === 0 ? (
      <p className="mt-3 text-xs text-muted-foreground">Sem {kind} disponíveis neste cliente.</p>
    ) : (
      <div className="mt-3 flex gap-2">
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger className="flex-1" aria-label={`Adicionar ${kind}`}><SelectValue placeholder={`Adicionar ${kind}…`} /></SelectTrigger>
          <SelectContent>
            {avail.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button onClick={onAdd} disabled={!value || busy}><Plus className="h-4 w-4" /> Vincular</Button>
      </div>
    )
  );

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Equipe: {team.name}</DialogTitle>
          <DialogDescription>Instâncias, membros e gestores</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive"><AlertCircle className="h-5 w-5" /></div>
            <p className="max-w-xs text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={load}>Tentar novamente</Button>
          </div>
        ) : (
          <Tabs defaultValue="instances" className="gap-4">
            <TabsList className="w-full">
              <TabsTrigger value="instances"><Radio className="h-4 w-4" /> Instâncias ({instances.length})</TabsTrigger>
              <TabsTrigger value="members"><User className="h-4 w-4" /> Membros ({members.length})</TabsTrigger>
              <TabsTrigger value="managers"><UserCog className="h-4 w-4" /> Gestores ({managers.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="instances">
              <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5" /> Vínculo explícito — os gestores da equipe acessam as conversas destas instâncias.
              </p>
              <div className="space-y-1.5">
                {instances.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                    Nenhuma instância vinculada.
                  </p>
                ) : instances.map((i) => (
                  <div key={i.id} className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                    <span className="min-w-0 flex-1 text-sm text-foreground">
                      {i.name} {i.phoneNumber && <span className="font-mono text-xs text-muted-foreground">{i.phoneNumber}</span>}
                    </span>
                    {i.captureMapped
                      ? <StatusBadge tone="success">Mapeada</StatusBadge>
                      : <span className="flex items-center gap-1 text-xs text-warning" title="Sem ponte de captura: o gestor não recebe conversas dessa instância"><AlertTriangle className="h-3.5 w-3.5" /> Sem captura</span>}
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Desvincular ${i.name}`} disabled={busy} onClick={() => removeInstance(i.id)}>
                      <Unlink className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
              {addRow(instToAdd, setInstToAdd, availInstances.map((i) => ({ id: i.id, label: `${i.name}${i.phoneNumber ? ` (${i.phoneNumber})` : ''}` })), addInstance, 'instância')}
            </TabsContent>

            <TabsContent value="members">
              {personList(members, 'Nenhum usuário vinculado.', removeMember)}
              {addRow(memberToAdd, setMemberToAdd, availMembers.map((u) => ({ id: u.id, label: `${u.name} (${u.email})` })), addMember, 'usuário')}
            </TabsContent>

            <TabsContent value="managers">
              {personList(managers, 'Nenhum gestor vinculado.', removeManager)}
              {addRow(mgrToAdd, setMgrToAdd, availGestores.map((u) => ({ id: u.id, label: `${u.name} (${u.email})` })), addManager, 'gestor')}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
