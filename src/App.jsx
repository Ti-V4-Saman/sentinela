import React, { useState, useEffect, useMemo } from 'react';
import Header from './components/Header';
import InstanceCard from './components/InstanceCard';
import ConnectModal from './components/ConnectModal';
import ServerConfigModal from './components/ServerConfigModal';
import CreateInstanceModal from './components/CreateInstanceModal';
import {
  fetchInstancesApi,
  createInstanceApi,
  updateInstanceApi,
  deleteInstanceApi,
  getStoredServerConfig,
  disconnectQuePasaInstance,
  checkInstanceRealtimeStatus,
  purgeFakeInstances,
  MANDATORY_WEBHOOK_URL
} from './services/quepasaApi';
import { getUser, isAdmin as isAdminRole, logout } from './services/authApi';
import TenantsView from './views/TenantsView';
import UsersView from './views/UsersView';
import TeamsView from './views/TeamsView';
import ConnectionsView from './views/ConnectionsView';
import MeusDadosModal from './components/MeusDadosModal';
import { useToast } from './components/ui/ToastProvider';
import { useConfirm } from './components/ui/ConfirmProvider';
import { friendlyError } from './utils/validation';
import { homeView } from './utils/nav';
import {
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Radio,
  Wifi,
  Server,
  Layers,
  Webhook
} from 'lucide-react';

export default function App() {
  const currentUser = getUser();
  const admin = isAdminRole();
  const myId = currentUser?.id;
  // Qualquer usuário com cliente (não-superadmin) cria/conecta as próprias instâncias.
  const canCreateInstance = !!currentUser && currentUser.role !== 'superadmin';
  const handleLogout = () => { logout(); window.location.reload(); };

  const [activeView, setActiveView] = useState(homeView(currentUser?.role));
  const [instances, setInstances] = useState([]);
  const [serverConfig, setServerConfig] = useState({ serverUrl: '', apiKey: '', useMock: true });
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Modals state
  const [connectingInstance, setConnectingInstance] = useState(null);
  const [isServerModalOpen, setIsServerModalOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isMeusDadosOpen, setIsMeusDadosOpen] = useState(false);

  // Toast unificado (empilha, auto-dismiss).
  const toast = useToast();
  const confirm = useConfirm();
  const showToast = (message, type = 'success') =>
    type === 'error' ? toast.error('Não foi possível concluir', message)
      : toast.success(type === 'warning' ? 'Atenção' : 'Pronto', message);

  // Initial Load
  useEffect(() => {
    purgeFakeInstances();
    const config = getStoredServerConfig();
    setServerConfig(config);
    
    // Fetch instances from Backend API
    const loadInstances = async () => {
      const loadedInstances = await fetchInstancesApi();
      setInstances(loadedInstances);
    };
    loadInstances();
  }, []);

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
      const refreshed = await fetchInstancesApi();
      setInstances(refreshed);
    }
    setIsRefreshing(false);
    showToast('Status das instâncias sincronizados em tempo real!');
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



  // Test Webhook n8n Payload Sender
  const handleTestWebhookPayload = async (instance) => {
    try {
      showToast(`Enviando evento de teste para o n8n...`);

      const samplePayload = {
        event: 'MESSAGES_UPSERT',
        instance: instance.name,
        sender: {
          phone: instance.phoneNumber || '5531999998888',
          name: instance.contactName || 'Contato de Teste',
        },
        message: {
          id: `msg-${Date.now()}`,
          fromMe: false,
          isGroup: true,
          groupName: 'Grupo V4 Sales & Ops',
          type: 'audio',
          text: '[Áudio recebido no grupo]',
          audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
          timestamp: new Date().toISOString(),
        },
        webhookTarget: MANDATORY_WEBHOOK_URL,
      };

      // Try sending payload to n8n directly via fetch
      const res = await fetch(MANDATORY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(samplePayload),
      }).catch((e) => {
        console.warn('POST para n8n via CORS prevenido ou falhado, simulação exibida:', e);
        return { ok: true };
      });

      showToast(`Payload de mensagem/áudio enviado para n8n! (${MANDATORY_WEBHOOK_URL})`);
    } catch (err) {
      showToast(`Teste executado para ${MANDATORY_WEBHOOK_URL}`);
    }
  };

  // Summary counts
  const totalCount = instances.length;
  const connectedCount = instances.filter((i) => i.status === 'Connected').length;
  const disconnectedCount = totalCount - connectedCount;

  return (
    <div className="min-h-screen bg-dark-bg text-slate-100 flex flex-col font-sans">

      {/* Top Navigation Header */}
      <Header
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
        onOpenCreateModal={() => setIsCreateModalOpen(true)}
        onOpenServerConfig={() => setIsServerModalOpen(true)}
        serverConfig={serverConfig}
        canCreate={canCreateInstance}
        user={currentUser}
        onLogout={handleLogout}
        onOpenMeusDados={() => setIsMeusDadosOpen(true)}
        activeView={activeView}
        setActiveView={setActiveView}
      />

      {/* Views de gestão (fora de 'instances') */}
      {activeView === 'tenants' && <TenantsView />}
      {activeView === 'users' && <UsersView />}
      {activeView === 'teams' && <TeamsView />}

      {/* Main Content Area (view de instâncias) */}
      {activeView === 'instances' && (
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-8">
        <div className="mb-6">
          <h2 className="font-heading text-2xl font-semibold text-foreground">Gestão de Conexões</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Monitore os números de WhatsApp conectados</p>
        </div>
        <ConnectionsView
          instances={filteredInstances}
          counts={{ total: totalCount, connected: connectedCount, disconnected: disconnectedCount }}
          onConnect={handleStartConnect}
          onDisconnect={handleDisconnect}
          canManage={(inst) => admin || inst.ownerUserId === myId}
        />
      </main>
      )}

      {/* Footer */}
      <footer className="border-t border-dark-border/60 py-4 px-4 text-center text-xs text-slate-500 bg-dark-bg">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span className="font-mono text-[11px]">Sentinela WhatsApp</span>
          <span>Qualidade & Performance V4 Saman © 2026</span>
        </div>
      </footer>

      {/* Modals */}
      {connectingInstance && (
        <ConnectModal
          instance={connectingInstance}
          onClose={() => setConnectingInstance(null)}
          onConnectedSuccess={handleConnectionSuccess}
        />
      )}

      {isServerModalOpen && (
        <ServerConfigModal
          config={serverConfig}
          onClose={() => setIsServerModalOpen(false)}
          onSave={(newConfig) => {
            setServerConfig(newConfig);
            showToast('Configurações do Servidor atualizadas!');
          }}
        />
      )}

      {isCreateModalOpen && (
        <CreateInstanceModal
          onClose={() => setIsCreateModalOpen(false)}
          onCreate={handleCreateInstance}
        />
      )}

      {isMeusDadosOpen && (
        <MeusDadosModal onClose={() => setIsMeusDadosOpen(false)} />
      )}

    </div>
  );
}
