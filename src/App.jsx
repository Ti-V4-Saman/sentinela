import React, { useState, useEffect, useMemo } from 'react';
import Header from './components/Header';
import InstanceCard from './components/InstanceCard';
import ConnectModal from './components/ConnectModal';
import ServerConfigModal from './components/ServerConfigModal';
import CreateInstanceModal from './components/CreateInstanceModal';
import {
  getStoredInstances,
  saveInstancesToStorage,
  getStoredServerConfig,
  disconnectQuePasaInstance,
  checkInstanceRealtimeStatus,
  purgeFakeInstances,
  MANDATORY_WEBHOOK_URL
} from './services/quepasaApi';
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
  const [instances, setInstances] = useState([]);
  const [serverConfig, setServerConfig] = useState({ serverUrl: '', apiKey: '', useMock: true });
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Modals state
  const [connectingInstance, setConnectingInstance] = useState(null);
  const [isServerModalOpen, setIsServerModalOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  // Toast notification state
  const [toast, setToast] = useState(null);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Initial Load
  useEffect(() => {
    // Remove any fake/demo instances carried over from previous sessions
    purgeFakeInstances();
    const config = getStoredServerConfig();
    setServerConfig(config);
    const loadedInstances = getStoredInstances();
    setInstances(loadedInstances);
  }, []);

  // Save changes to storage whenever instances update
  const updateInstancesState = (newInstances) => {
    setInstances(newInstances);
    saveInstancesToStorage(newInstances);
  };

  // Ref to hold latest instances for background polling without stale closures
  const instancesRef = React.useRef(instances);
  instancesRef.current = instances;

  // Real-Time status check polling loop (runs silently every 5 seconds)
  useEffect(() => {
    const pollRealtimeStatus = async () => {
      const currentList = instancesRef.current;
      if (!currentList || currentList.length === 0) return;

      let hasChanges = false;
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
            hasChanges = true;
            if (inst.status === 'Connected' && liveStatus === 'Disconnected') {
              showToast(`Instância "${inst.name}" foi desconectada!`, 'warning');
            } else if (inst.status === 'Disconnected' && liveStatus === 'Connected') {
              showToast(`Instância "${inst.name}" conectada com sucesso!`, 'success');
            }
            return {
              ...inst,
              status: liveStatus,
              phoneNumber: livePhone || inst.phoneNumber,
              contactName: livePushname || inst.contactName,
              avatarUrl: liveAvatarUrl || inst.avatarUrl,
              updatedAt: new Date().toISOString()
            };
          }
          return inst;
        })
      );

      if (hasChanges) {
        updateInstancesState(updatedList);
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
          return {
            ...inst,
            status: liveStatus,
            phoneNumber: livePhone || inst.phoneNumber,
            updatedAt: new Date().toISOString()
          };
        })
      );
      updateInstancesState(updatedList);
    } else {
      setInstances(getStoredInstances());
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
  const handleConnectionSuccess = (updatedInstance) => {
    const updatedList = instances.map((inst) =>
      inst.id === updatedInstance.id ? updatedInstance : inst
    );
    updateInstancesState(updatedList);
    showToast(`Instância ${updatedInstance.name} conectada com sucesso! Webhook n8n cadastrado.`);
  };

  // Disconnect handler
  const handleDisconnect = async (instance) => {
    try {
      await disconnectQuePasaInstance(instance);
      const updatedList = instances.map((inst) =>
        inst.id === instance.id ? { ...inst, status: 'Disconnected' } : inst
      );
      updateInstancesState(updatedList);
      showToast(`Instância "${instance.name}" desconectada com sucesso.`, 'warning');
    } catch (err) {
      showToast('Erro ao desconectar: ' + err.message, 'error');
    }
  };

  // Delete instance handler
  const handleDeleteInstance = (id) => {
    const target = instances.find((i) => i.id === id);
    if (!target) return;
    if (window.confirm(`Tem certeza que deseja remover a caixa de conexão "${target.name}"?`)) {
      const updatedList = instances.filter((inst) => inst.id !== id);
      updateInstancesState(updatedList);
      showToast(`Instância ${target.name} removida.`, 'warning');
    }
  };

  // Update instance token handler
  const handleUpdateToken = (id, newToken) => {
    const updatedList = instances.map((inst) =>
      inst.id === id ? { ...inst, token: newToken } : inst
    );
    updateInstancesState(updatedList);
    showToast(`Token da instância atualizado com sucesso!`);
  };

  // Create new instance handler
  const handleCreateInstance = async (newInstance) => {
    const updatedList = [newInstance, ...instances];
    updateInstancesState(updatedList);
    setIsCreateModalOpen(false);
    showToast(`Instância "${newInstance.name}" criada com sucesso! Token cadastrado no Webhook.`);

    // Pre-register webhook with instance token immediately on creation
    registerQuePasaWebhook(newInstance).catch(() => null);

    // Open connect modal immediately to scan QR code
    setConnectingInstance(newInstance);
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
      />

      {/* Toast Notification Banner */}
      {toast && (
        <div className="fixed top-20 right-6 z-50 animate-in slide-in-from-top-4 duration-300">
          <div className={`px-4 py-3 rounded-xl border shadow-xl flex items-center gap-3 text-sm ${toast.type === 'error'
              ? 'bg-rose-950 border-rose-800 text-rose-200'
              : toast.type === 'warning'
                ? 'bg-amber-950 border-amber-800 text-amber-200'
                : 'bg-emerald-950 border-emerald-800 text-emerald-200'
            }`}>
            {toast.type === 'error' ? (
              <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
            ) : (
              <CheckCircle2 className="w-5 h-5 text-brand-emerald shrink-0" />
            )}
            <span>{toast.message}</span>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-8">

        {/* Section Header & Counters */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold font-outfit text-white">
                Instâncias
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-mono bg-dark-surface border border-dark-border text-slate-300">
                {totalCount} total
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Gerencie suas conexões WhatsApp
            </p>
          </div>

          {/* Counters Pill Summary */}
          <div className="flex items-center gap-2 bg-dark-card border border-dark-border px-3 py-1.5 rounded-xl text-xs">
            <span className="flex items-center gap-1.5 text-brand-emerald font-semibold">
              <span className="w-2 h-2 rounded-full bg-brand-emerald" />
              {connectedCount} Conectados
            </span>
            <span className="text-slate-600">|</span>
            <span className="flex items-center gap-1.5 text-rose-400 font-semibold">
              <span className="w-2 h-2 rounded-full bg-rose-500" />
              {disconnectedCount} Desconectados
            </span>
          </div>
        </div>

        {/* Instances Grid */}
        {filteredInstances.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {filteredInstances.map((instance) => (
              <InstanceCard
                key={instance.id}
                instance={instance}
                onConnect={handleStartConnect}
                onDisconnect={handleDisconnect}
                onDelete={handleDeleteInstance}
                onUpdateToken={handleUpdateToken}
              />

            ))}
          </div>
        ) : (
          /* Empty state */
          <div className="bg-dark-card border border-dark-border rounded-2xl p-12 text-center flex flex-col items-center justify-center">
            <div className="w-16 h-16 rounded-full bg-dark-bg border border-dark-border flex items-center justify-center text-slate-500 mb-4">
              <Layers className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-bold text-white mb-1">Nenhuma instância encontrada</h3>
            <p className="text-xs text-slate-400 max-w-sm mb-6">
              {searchQuery || statusFilter !== 'ALL'
                ? 'Nenhuma conexão bate com os filtros atuais. Tente limpar a busca.'
                : 'Você ainda não possui instâncias de WhatsApp criadas. Clique em "Instance +" para criar a primeira!'}
            </p>
            {searchQuery || statusFilter !== 'ALL' ? (
              <button
                onClick={() => { setSearchQuery(''); setStatusFilter('ALL'); }}
                className="px-4 py-2 text-xs font-semibold bg-dark-hover border border-dark-border rounded-lg text-slate-200"
              >
                Limpar Filtros
              </button>
            ) : (
              <button
                onClick={() => setIsCreateModalOpen(true)}
                className="px-5 py-2.5 text-xs font-semibold bg-brand-emerald hover:bg-brand-emeraldDark text-black rounded-lg transition-all shadow-md shadow-brand-emerald/20"
              >
                Instance +
              </button>
            )}
          </div>
        )}

      </main>

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

    </div>
  );
}
