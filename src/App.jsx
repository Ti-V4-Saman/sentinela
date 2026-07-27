import React, { useState, useEffect, useMemo } from 'react';
import { ConnectDialog } from './components/instances/connect-dialog';
import { ServerConfigDialog } from './components/settings/server-config-dialog';
import { CreateInstanceDialog } from './components/instances/create-instance-dialog';
import {
  fetchInstancesApi,
  createInstanceApi,
  updateInstanceApi,
  getStoredServerConfig,
  disconnectQuePasaInstance,
  checkInstanceRealtimeStatus,
  purgeFakeInstances,
} from './services/quepasaApi';
import { getUser, isAdmin as isAdminRole, logout } from './services/authApi';
import { AppShell } from './components/shell/AppShell';
import ClientsView from './views/ClientsView';
import UsersView from './views/UsersView';
import TeamsView from './views/TeamsView';
import ConnectionsView from './views/ConnectionsView';
import { MeusDadosDialog } from './components/account/meus-dados-dialog';
import { EditTokenDialog } from './components/instances/edit-token-dialog';
import { CaptureWidDialog } from './components/instances/capture-wid-dialog';
import { useToast } from './components/ui/ToastProvider';
import { useConfirm } from './components/ui/ConfirmProvider';
import { friendlyError } from './utils/validation';
import { homeView } from './utils/nav';

export default function App() {
  const [currentUser, setCurrentUser] = useState(getUser());
  const admin = isAdminRole();
  const myId = currentUser?.id;
  // Qualquer usuário com cliente (não-superadmin) cria/conecta as próprias instâncias.
  const canCreateInstance = !!currentUser && currentUser.role !== 'superadmin';
  const handleLogout = () => { logout(); window.location.reload(); };

  const [activeView, setActiveView] = useState(homeView(currentUser?.role));
  const [instances, setInstances] = useState([]);
  const [instancesLoading, setInstancesLoading] = useState(true);
  const [instancesError, setInstancesError] = useState('');
  const [serverConfig, setServerConfig] = useState({ serverUrl: '', apiKey: '', useMock: true });
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Modals state
  const [connectingInstance, setConnectingInstance] = useState(null);
  const [isServerModalOpen, setIsServerModalOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isMeusDadosOpen, setIsMeusDadosOpen] = useState(false);
  const [editTokenInstance, setEditTokenInstance] = useState(null);
  const [captureInstance, setCaptureInstance] = useState(null);

  // Carrega as conexões (com loading/erro para a UI).
  const loadInstances = React.useCallback(async () => {
    setInstancesLoading(true); setInstancesError('');
    try {
      setInstances(await fetchInstancesApi());
    } catch (e) {
      setInstancesError(e.message || 'Falha ao carregar as conexões');
    } finally {
      setInstancesLoading(false);
    }
  }, []);

  // Toast unificado (empilha, auto-dismiss).
  const toast = useToast();
  const confirm = useConfirm();
  const showToast = (message, type = 'success') =>
    type === 'error' ? toast.error('Não foi possível concluir', message)
      : toast.success(type === 'warning' ? 'Atenção' : 'Pronto', message);

  // Initial Load
  useEffect(() => {
    purgeFakeInstances();
    setServerConfig(getStoredServerConfig());
    loadInstances();
  }, [loadInstances]);

  // Ref to hold latest instances for background polling without stale closures
  const instancesRef = React.useRef(instances);
  instancesRef.current = instances;

  // Real-Time status check polling loop (runs silently every 5 seconds)
  useEffect(() => {
    const pollRealtimeStatus = async () => {
      const currentList = instancesRef.current;
      if (!currentList || currentList.length === 0) return;

      let stateNeedsUpdate = false;
      const updatedList = await Promise.all(
        currentList.map(async (inst) => {
          const res = await checkInstanceRealtimeStatus(inst);
          const liveStatus = typeof res === 'string' ? res : res?.status;
          const livePhone = typeof res === 'object' ? res?.phoneNumber : inst.phoneNumber;
          const livePushname = typeof res === 'object' ? res?.pushname : null;
          const liveAvatarUrl = typeof res === 'object' ? res?.avatarUrl : null;

          const statusChanged = liveStatus !== inst.status;
          const phoneChanged = livePhone && livePhone !== inst.phoneNumber;
          const nameChanged = livePushname && livePushname !== inst.contactName;
          const avatarChanged = liveAvatarUrl && liveAvatarUrl !== inst.avatarUrl;

          if (statusChanged || phoneChanged || nameChanged || avatarChanged) {
            stateNeedsUpdate = true;
            if (inst.status === 'Connected' && liveStatus === 'Disconnected') {
              showToast(`Instância "${inst.name}" foi desconectada!`, 'warning');
            } else if (inst.status === 'Disconnected' && liveStatus === 'Connected') {
              showToast(`Instância "${inst.name}" conectada com sucesso!`, 'success');
            }
            
            const updates = {
              status: liveStatus,
              phoneNumber: livePhone || inst.phoneNumber,
              contactName: livePushname || inst.contactName,
              avatarUrl: liveAvatarUrl || inst.avatarUrl,
            };
            
            // Persist to Backend API silently
            updateInstanceApi(inst.id, updates).catch(e => console.error(e));
            
            return { ...inst, ...updates, updatedAt: new Date().toISOString() };
          }
          return inst;
        })
      );

      if (stateNeedsUpdate) {
        setInstances(updatedList);
      }
    };

    pollRealtimeStatus(); // Run immediately
    const intervalId = setInterval(pollRealtimeStatus, 5000);
    return () => clearInterval(intervalId);
  }, []);

  // Refresh instances manually
  const handleRefresh = async () => {
    setIsRefreshing(true);
    if (!serverConfig.useMock && instances.length > 0) {
      const updatedList = await Promise.all(
        instances.map(async (inst) => {
          const res = await checkInstanceRealtimeStatus(inst);
          const liveStatus = typeof res === 'string' ? res : res?.status;
          const livePhone = typeof res === 'object' ? res?.phoneNumber : inst.phoneNumber;
          const updates = {
            status: liveStatus,
            phoneNumber: livePhone || inst.phoneNumber
          };
          updateInstanceApi(inst.id, updates).catch(e => console.error(e));
          return { ...inst, ...updates, updatedAt: new Date().toISOString() };
        })
      );
      setInstances(updatedList);
    } else {
      try {
        setInstances(await fetchInstancesApi());
      } catch (e) {
        toast.error('Não foi possível atualizar', friendlyError(e.message));
      }
    }
    setIsRefreshing(false);
    showToast('Status das conexões sincronizado!');
  };

  // Filtered instances calculation
  const filteredInstances = useMemo(() => {
    return instances.filter((inst) => {
      const matchesSearch =
        inst.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (inst.contactName && inst.contactName.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (inst.phoneNumber && inst.phoneNumber.includes(searchQuery));

      const matchesStatus =
        statusFilter === 'ALL' ||
        inst.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [instances, searchQuery, statusFilter]);

  // Connect / Reconnect modal trigger
  const handleStartConnect = (instance) => {
    setConnectingInstance(instance);
  };

  // Callback when connected successfully
  const handleConnectionSuccess = async (updatedInstance) => {
    try {
      await updateInstanceApi(updatedInstance.id, { 
        status: 'Connected', 
        phoneNumber: updatedInstance.phoneNumber,
        contactName: updatedInstance.contactName,
        avatarUrl: updatedInstance.avatarUrl 
      });
      const updatedList = instances.map((inst) =>
        inst.id === updatedInstance.id ? updatedInstance : inst
      );
      setInstances(updatedList);
      showToast(`Instância ${updatedInstance.name} conectada com sucesso! Webhook n8n cadastrado.`);
    } catch (e) {
      showToast('Erro ao atualizar status da instância no servidor.', 'error');
    }
  };

  // Disconnect handler
  const handleDisconnect = async (instance) => {
    try {
      await disconnectQuePasaInstance(instance);
      await updateInstanceApi(instance.id, { status: 'Disconnected' });
      const updatedList = instances.map((inst) =>
        inst.id === instance.id ? { ...inst, status: 'Disconnected' } : inst
      );
      setInstances(updatedList);
      showToast(`Instância "${instance.name}" desconectada com sucesso.`, 'warning');
    } catch (err) {
      showToast('Erro ao desconectar: ' + err.message, 'error');
    }
  };

  // Instância NUNCA é excluída (decisão de produto — histórico p/ pesquisas/relatórios).

  // Update instance token handler
  const handleUpdateToken = async (id, newToken) => {
    try {
      await updateInstanceApi(id, { token: newToken });
      const updatedList = instances.map((inst) =>
        inst.id === id ? { ...inst, token: newToken } : inst
      );
      setInstances(updatedList);
      showToast(`Token da instância atualizado com sucesso!`);
    } catch (err) {
      showToast('Erro ao atualizar token.', 'error');
    }
  };

  // Create new instance handler
  const handleCreateInstance = async (newInstance) => {
    // Erros (ex.: número duplicado → 409) são relançados para o modal exibir inline.
    const created = await createInstanceApi(newInstance);
    const updatedList = [created, ...instances];
    setInstances(updatedList);
    setIsCreateModalOpen(false);
    toast.success('Instância criada', `"${created.name}" foi criada. Escaneie o QR para conectar.`);
    setConnectingInstance(created);
  };



  // Summary counts
  const totalCount = instances.length;
  const connectedCount = instances.filter((i) => i.status === 'Connected').length;
  const disconnectedCount = totalCount - connectedCount;

  return (
    <AppShell
      user={currentUser}
      activeView={activeView}
      setActiveView={setActiveView}
      onOpenMeusDados={() => setIsMeusDadosOpen(true)}
      onOpenServerConfig={admin || currentUser?.role === 'superadmin' ? () => setIsServerModalOpen(true) : undefined}
      onLogout={handleLogout}
      onHome={() => setActiveView(homeView(currentUser?.role))}
    >
      {activeView === 'instances' && (
        <ConnectionsView
          instances={filteredInstances}
          rawCount={instances.length}
          counts={{ total: totalCount, connected: connectedCount, disconnected: disconnectedCount }}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          onConnect={handleStartConnect}
          onDisconnect={handleDisconnect}
          onEditToken={(inst) => setEditTokenInstance(inst)}
          canMapCapture={admin}
          onMapCapture={(inst) => setCaptureInstance(inst)}
          canManage={(inst) => admin || inst.ownerUserId === myId}
          canCreate={canCreateInstance}
          onCreate={() => setIsCreateModalOpen(true)}
          onRefresh={handleRefresh}
          isRefreshing={isRefreshing}
          loading={instancesLoading}
          error={instancesError}
          onRetry={loadInstances}
        />
      )}
      {activeView === 'tenants' && <ClientsView />}
      {activeView === 'users' && <UsersView />}
      {activeView === 'teams' && <TeamsView />}

      {/* Modais */}
      {connectingInstance && (
        <ConnectDialog
          instance={connectingInstance}
          onClose={() => setConnectingInstance(null)}
          onConnectedSuccess={handleConnectionSuccess}
        />
      )}
      {isServerModalOpen && (
        <ServerConfigDialog
          config={serverConfig}
          onClose={() => setIsServerModalOpen(false)}
          onSave={(newConfig) => { setServerConfig(newConfig); showToast('Configurações do servidor atualizadas!'); }}
        />
      )}
      {isCreateModalOpen && (
        <CreateInstanceDialog onClose={() => setIsCreateModalOpen(false)} onCreate={handleCreateInstance} />
      )}
      {isMeusDadosOpen && (
        <MeusDadosDialog
          onClose={() => setIsMeusDadosOpen(false)}
          onUpdated={(u) => setCurrentUser((prev) => ({ ...prev, name: u.name }))}
        />
      )}
      {editTokenInstance && (
        <EditTokenDialog
          instance={editTokenInstance}
          onClose={() => setEditTokenInstance(null)}
          onSave={handleUpdateToken}
        />
      )}
      {captureInstance && (
        <CaptureWidDialog
          instance={captureInstance}
          onClose={() => setCaptureInstance(null)}
          onSaved={() => { loadInstances(); showToast('Mapeamento de captura atualizado!'); }}
        />
      )}
    </AppShell>
  );
}
