// QuePasa WhatsApp Service & Webhook Integration Layer

export const MANDATORY_WEBHOOK_URL = 'https://n8.v4saman.com/webhook/sentinela-whatsapp-v4';

const STORAGE_KEYS = {
  SERVER_URL: 'quepasa_server_url',
  API_KEY: 'quepasa_api_key',
  INSTANCES: 'quepasa_instances_v1',
  MOCK_MODE: 'quepasa_use_mock',
};

// IDs of demo/fake instances that should be purged from localStorage on load
const FAKE_INSTANCE_IDS = ['inst-judith', 'inst-iasaman', 'inst-chefgourmet', 'inst-giovani'];
const FAKE_INSTANCE_TOKENS = [
  '7a89b4f1-3d2e-4f8a-9e1b-0248c1d5e3f4',
  '2c41e892-9a0b-41c3-b82d-119e7a4b6f02',
  '8f91a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b',
  'e4f5a6b7-c8d9-40e1-a2b3-c4d5e6f7a8b9',
];

/**
 * Purges fake/demo instances from localStorage so only real instances remain.
 * Called automatically on app init.
 */
export const purgeFakeInstances = () => {
  const saved = localStorage.getItem(STORAGE_KEYS.INSTANCES);
  if (!saved) return;
  try {
    const instances = JSON.parse(saved);
    const realInstances = instances.filter(
      (inst) => !FAKE_INSTANCE_IDS.includes(inst.id) && !FAKE_INSTANCE_TOKENS.includes(inst.token)
    );
    if (realInstances.length !== instances.length) {
      localStorage.setItem(STORAGE_KEYS.INSTANCES, JSON.stringify(realInstances));
      console.log(`[Sentinela] Removidas ${instances.length - realInstances.length} instância(s) de demonstração.`);
    }
  } catch (e) {
    // ignore parse errors
  }
};

// Helper to manage storage
export const getStoredServerConfig = () => {
  const envServerUrl = import.meta.env.VITE_QUEPASA_SERVER_URL || '';
  const envApiKey = import.meta.env.VITE_QUEPASA_API_KEY || '';
  const envUseMock = import.meta.env.VITE_USE_MOCK === 'true';

  const storedServerUrl = localStorage.getItem(STORAGE_KEYS.SERVER_URL);
  const storedApiKey = localStorage.getItem(STORAGE_KEYS.API_KEY);
  const storedMockMode = localStorage.getItem(STORAGE_KEYS.MOCK_MODE);

  const serverUrl = storedServerUrl !== null ? storedServerUrl : (envServerUrl || 'https://apiwhatsapp.v4saman.com');
  const isRealServer = serverUrl.includes('apiwhatsapp.v4saman.com') || serverUrl.startsWith('http');

  return {
    serverUrl,
    apiKey: storedApiKey !== null ? storedApiKey : envApiKey,
    useMock: isRealServer ? false : (storedMockMode !== null ? storedMockMode === 'true' : envUseMock),
  };
};

export const saveServerConfig = (serverUrl, apiKey, useMock) => {
  localStorage.setItem(STORAGE_KEYS.SERVER_URL, serverUrl);
  localStorage.setItem(STORAGE_KEYS.API_KEY, apiKey);
  localStorage.setItem(STORAGE_KEYS.MOCK_MODE, useMock ? 'true' : 'false');
};

// DB API Helpers
const API_BASE = '/api/instances';
const API_KEY = import.meta.env.VITE_API_SECRET_KEY || '';
const API_HEADERS = {
  'Content-Type': 'application/json',
  'X-Sentinela-Key': API_KEY,
};

export const fetchInstancesApi = async () => {
  try {
    const res = await fetch(API_BASE, { headers: API_HEADERS });
    if (!res.ok) throw new Error('Failed to fetch instances');
    return await res.json();
  } catch (e) {
    console.error('Error fetching from backend:', e);
    return [];
  }
};

export const createInstanceApi = async (instance) => {
  try {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: API_HEADERS,
      body: JSON.stringify(instance),
    });
    if (!res.ok) throw new Error('Failed to create instance');
    return await res.json();
  } catch (e) {
    console.error('Error creating instance in DB:', e);
    throw e;
  }
};

export const updateInstanceApi = async (id, data) => {
  try {
    const res = await fetch(`${API_BASE}/${id}`, {
      method: 'PUT',
      headers: API_HEADERS,
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to update instance');
    return await res.json();
  } catch (e) {
    console.error('Error updating instance in DB:', e);
    throw e;
  }
};

export const deleteInstanceApi = async (id) => {
  try {
    const res = await fetch(`${API_BASE}/${id}`, {
      method: 'DELETE',
      headers: API_HEADERS,
    });
    if (!res.ok) throw new Error('Failed to delete instance');
    return await res.json();
  } catch (e) {
    console.error('Error deleting instance in DB:', e);
    throw e;
  }
};


// Helper to extract sensitive token from endpoint URL and move it to x-quepasa-token header
const prepareSecureRequest = (endpoint) => {
  let cleanEndpoint = endpoint;
  let extractedToken = null;

  // 1. Extract token from query params if present
  if (cleanEndpoint.includes('token=')) {
    try {
      const dummyUrl = new URL('http://dummy.com' + (cleanEndpoint.startsWith('/') ? cleanEndpoint : '/' + cleanEndpoint));
      extractedToken = dummyUrl.searchParams.get('token');
      dummyUrl.searchParams.delete('token');
      cleanEndpoint = dummyUrl.pathname + (dummyUrl.search ? dummyUrl.search : '');
    } catch {
      cleanEndpoint = cleanEndpoint.replace(/([?&])token=[^&]*&?/, '$1').replace(/[?&]$/, '');
    }
  }

  // 2. Extract token from path: /v3/bot/<UUID>/... -> /v3/bot/self/...
  const botPathMatch = cleanEndpoint.match(/\/v3\/bot\/([a-zA-Z0-9-]{10,})\/(.*)/);
  if (botPathMatch) {
    if (!extractedToken) extractedToken = botPathMatch[1];
    cleanEndpoint = cleanEndpoint.replace(/\/v3\/bot\/[^\/]+\//, '/v3/bot/self/');
  }

  return { cleanEndpoint, extractedToken };
};

// API Call helper with automatic CORS proxy fallback & header-based token protection
const makeApiRequest = async (endpoint, options = {}) => {
  const { serverUrl, apiKey } = getStoredServerConfig();
  const { cleanEndpoint, extractedToken } = prepareSecureRequest(endpoint);

  const directUrl = `${serverUrl.replace(/\/$/, '')}${endpoint}`;
  // Use cleanEndpoint so token parameter is omitted from browser Network tab and added server-side by proxy
  const proxyUrl = `/quepasa-proxy${cleanEndpoint}`;

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    ...(extractedToken ? { 'x-quepasa-token': extractedToken } : {}),
    ...(apiKey ? { 'Authorization': apiKey.startsWith('Basic ') ? apiKey : `Bearer ${apiKey}` } : {}),
    ...options.headers,
  };


  try {
    const response = await fetch(proxyUrl, {
      ...options,
      cache: 'no-store',
      headers,
    }).catch(async (proxyErr) => {
      return await fetch(directUrl, { ...options, cache: 'no-store', headers });
    });


    if (!response.ok && response.status !== 204) {
      throw new Error(`QuePasa API HTTP ${response.status}: ${response.statusText}`);
    }

    if (response.status === 204) {
      return { success: false, status: 204 };
    }

    const text = await response.text();
    if (!text || !text.trim()) {
      return { success: response.ok, status: response.status };
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      return { success: response.ok, status: response.status, rawText: text };
    }
  } catch (err) {
    if (err.message.includes('Failed to fetch') || err.name === 'TypeError') {
      throw new Error(`Não foi possível alcançar o servidor (${serverUrl}). Verifique se o servidor está online e se as regras de CORS ou SSL do Traefik estão liberadas.`);
    }
    throw err;
  }
};

// Binary Blob API Call helper for QR Code Images with token protection
const makeApiBlobRequest = async (endpoint, options = {}) => {
  const { serverUrl, apiKey } = getStoredServerConfig();
  const { cleanEndpoint, extractedToken } = prepareSecureRequest(endpoint);

  const directUrl = `${serverUrl.replace(/\/$/, '')}${endpoint}`;
  const proxyUrl = `/quepasa-proxy${cleanEndpoint}`;

  const headers = {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    ...(extractedToken ? { 'x-quepasa-token': extractedToken } : {}),
    ...(apiKey ? { 
      'Authorization': apiKey.startsWith('Basic ') ? apiKey : `Bearer ${apiKey}`,
      'apikey': apiKey,
      'secret': apiKey,
      'x-secret': apiKey,
      'signing-secret': apiKey,
    } : {}),
    ...options.headers,
  };

  const response = await fetch(proxyUrl, {
    ...options,
    cache: 'no-store',
    headers,
  }).catch(async () => {
    return await fetch(directUrl, { ...options, cache: 'no-store', headers });
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
};


/**
 * Helper to generate full Webhook URL with token query param
 */
export const getWebhookUrlForInstance = (token) => {
  if (!token) return MANDATORY_WEBHOOK_URL;
  return `${MANDATORY_WEBHOOK_URL}?token=${encodeURIComponent(token)}`;
};

/**
 * Register the compulsory Webhook URL to QuePasa for a specific instance
 */
export const registerQuePasaWebhook = async (instance) => {
  const { useMock } = getStoredServerConfig();
  const instanceObj = typeof instance === 'string' ? { name: instance, token: instance } : instance;
  const instanceName = instanceObj.name;
  const token = instanceObj.token || instanceName;
  const user = instanceObj.user || import.meta.env.VITE_QUEPASA_USER || 'ti.bh@v4company.com';

  const fullWebhookUrl = getWebhookUrlForInstance(token);
  const extraJsonString = JSON.stringify({ token: token, instance: instanceName });

  console.log(`[QuePasa Webhook] Cadastrando webhook para ${instanceName}...`);
  console.log(`[QuePasa Webhook] URL Alvo: ${fullWebhookUrl}`);
  console.log(`[QuePasa Webhook] Extra Data: ${extraJsonString}`);

  if (useMock) {
    return {
      success: true,
      webhookUrl: fullWebhookUrl,
      events: ['messages.upsert', 'audio', 'messages.group', 'audio.group'],
      message: 'Webhook cadastrado com sucesso no n8n (Modo Demo)',
    };
  }

  try {
    const payload = {
      url: fullWebhookUrl,
      method: 'POST',
      trackid: token,
      extra: extraJsonString,
    };

    const res = await makeApiRequest(`/webhook?token=${encodeURIComponent(token)}&user=${encodeURIComponent(user)}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }).catch(async () => {
      return await makeApiRequest(`/v3/bot/${encodeURIComponent(token)}/webhook`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }).catch(() => ({ success: true, fallback: true }));
    });

    return {
      success: true,
      data: res,
      webhookUrl: fullWebhookUrl
    };
  } catch (err) {
    console.warn(`[QuePasa Webhook Warning] Registro local: ${err.message}`);
    return {
      success: true,
      fallback: true,
      webhookUrl: fullWebhookUrl
    };
  }
};



/**
 * Fetch QR Code data or Pairing Code for connecting a WhatsApp number
 */
export const fetchQRCode = async (instance, phoneNumber = '') => {
  const { useMock } = getStoredServerConfig();
  const instanceName = typeof instance === 'string' ? instance : instance.name;
  const token = instance?.token || instanceName;
  const user = instance?.user || import.meta.env.VITE_QUEPASA_USER || 'ti.bh@v4company.com';
  const cleanPhone = (phoneNumber || instance?.phoneNumber || '').replace(/\D/g, '');

  if (useMock) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const mockQRData = `2@${Math.random().toString(36).substring(2)},${Math.random().toString(36).substring(2)}`;
    const mockPairingCode = Math.floor(10000000 + Math.random() * 90000000).toString();
    
    return {
      qrCode: mockQRData,
      pairingCode: mockPairingCode,
      qrImageUrl: '',
      status: 'QR_READY',
    };
  }

  try {
    // QuePasa v5 QR Code direct PNG image endpoint via authenticated fetch
    const scanEndpoint = `/scan?token=${encodeURIComponent(token)}&user=${encodeURIComponent(user)}`;
    let qrImageUrl = '';
    
    try {
      qrImageUrl = await makeApiBlobRequest(scanEndpoint);
    } catch (e) {
      console.warn('QR Blob fetch error:', e.message);
      throw e;
    }

    let pairingCode = '';
    if (cleanPhone) {
      try {
        const pairData = await makeApiRequest(`/paircode?token=${encodeURIComponent(token)}&user=${encodeURIComponent(user)}&phone=${cleanPhone}`, { method: 'GET' });
        pairingCode = pairData.status || pairData.code || pairData.pairingCode || '';
      } catch (e) {
        console.warn('Pairing code fetch:', e.message);
      }
    }

    return {
      qrCode: qrImageUrl ? 'direct_png' : '',
      qrImageUrl: qrImageUrl,
      pairingCode: pairingCode,
      status: 'QR_READY',
    };
  } catch (err) {
    throw new Error(`Falha ao obter QR Code da API QuePasa: ${err.message}`);
  }
};

/**
 * Disconnect an instance
 */
export const disconnectQuePasaInstance = async (instance) => {
  const { useMock } = getStoredServerConfig();
  const instanceObj = typeof instance === 'string' ? { name: instance, token: instance } : instance;
  const instanceName = instanceObj.name;
  const token = instanceObj.token || instanceName;
  const rawPhone = instanceObj.phoneNumber ? instanceObj.phoneNumber.split(':')[0] : '';
  const user = instanceObj.user || import.meta.env.VITE_QUEPASA_USER || 'ti.bh@v4company.com';

  if (useMock) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { success: true };
  }

  try {
    // 1. Attempt DELETE /info with token
    await makeApiRequest(`/info?token=${encodeURIComponent(token)}&user=${encodeURIComponent(user)}`, { method: 'DELETE' }).catch(() => null);
    
    // 2. Attempt DELETE /info with instance name
    if (instanceName && instanceName !== token) {
      await makeApiRequest(`/info?token=${encodeURIComponent(instanceName)}&user=${encodeURIComponent(user)}`, { method: 'DELETE' }).catch(() => null);
    }
    
    // 3. Attempt DELETE /info with raw phone number if present
    if (rawPhone) {
      await makeApiRequest(`/info?token=${encodeURIComponent(rawPhone)}&user=${encodeURIComponent(user)}`, { method: 'DELETE' }).catch(() => null);
    }

    return { success: true };
  } catch (err) {
    console.warn(`Logout aplicado localmente: ${err.message}`);
    return { success: true };
  }
};

/**
 * Fetch real WhatsApp profile picture and contact name using QuePasa API endpoints:
 * 1. POST /v3/bot/{token}/picinfo -> fetches avatarUrl (pps.whatsapp.net image)
 * 2. GET /contacts?token={token} -> finds contact matching instance phone -> fetches real name (e.g., "Giovani Maia")
 */
const fetchProfileInfo = async (token, wid, cleanPhone) => {
  try {
    if (!token) return {};

    const rawNumber = cleanPhone || (wid ? wid.split('@')[0].split(':')[0] : '');
    const domain = wid && wid.includes('@') ? wid.split('@')[1] : 's.whatsapp.net';
    const cleanJid = rawNumber ? `${rawNumber}@${domain}` : '';

    const { serverUrl, apiKey } = getStoredServerConfig();
    const baseUrl = serverUrl?.replace(/\/$/, '') || 'https://apiwhatsapp.v4saman.com';

    let avatarUrl = '';
    let pushname = '';

    // 1. Fetch profile picture via /v3/bot/self/picinfo (token hidden in x-quepasa-token header)
    if (cleanJid) {
      try {
        const proxyPicUrl = `/quepasa-proxy/v3/bot/self/picinfo`;
        const body = JSON.stringify({ chatid: cleanJid });
        const headers = {
          'Content-Type': 'application/json',
          'x-quepasa-token': token,
        };

        const res = await fetch(proxyPicUrl, { method: 'POST', cache: 'no-store', headers, body }).catch(() => null);

        if (res && res.ok) {
          const data = await res.json().catch(() => ({}));
          avatarUrl = data.info?.url || data.url || data.picture || data.profilepicurl || '';
        }
      } catch {
        // Ignore temporary profile pic unavailability
      }
    }

    // 2. Fetch real WhatsApp contact name via GET /contacts
    try {
      const user = import.meta.env.VITE_QUEPASA_USER || 'ti.bh@v4company.com';
      const contactsData = await makeApiRequest(
        `/contacts?token=${encodeURIComponent(token)}&user=${encodeURIComponent(user)}`,
        { method: 'GET' }
      ).catch(() => null);

      if (contactsData && Array.isArray(contactsData.contacts)) {
        const match = contactsData.contacts.find((c) => {
          if (!rawNumber) return false;
          const cleanContactPhone = c.phone ? c.phone.replace(/\D/g, '') : '';
          return (c.id && c.id.includes(rawNumber)) || (cleanContactPhone && cleanContactPhone.includes(rawNumber));
        });

        if (match) {
          pushname = match.title || match.name || match.pushname || '';
        }
      }
    } catch {
      // Ignore temporary contacts unavailability
    }

    return {
      avatarUrl,
      pushname,
    };
  } catch {
    return {};
  }
};


/**
 * Check real-time connection status of an instance against QuePasa server.
 *
 * QuePasa HTTP response semantics (confirmed via testing):
 *  - GET /info → HTTP 200 + { server: { verified: true } }   → Connected
 *  - GET /info → HTTP 200 + { server: { verified: false } }  → Disconnected (session exists but logged out)
 *  - GET /info → HTTP 204 (No Content)                       → Disconnected (no session at all)
 */
export const checkInstanceRealtimeStatus = async (instance) => {
  const { useMock } = getStoredServerConfig();
  if (useMock) return instance.status;

  const token = instance?.token;
  const user = instance?.user || import.meta.env.VITE_QUEPASA_USER || 'ti.bh@v4company.com';

  if (!token || token.trim() === '') return { status: 'Disconnected' };

  try {
    const infoData = await makeApiRequest(
      `/info?token=${encodeURIComponent(token)}&user=${encodeURIComponent(user)}`,
      { method: 'GET' }
    ).catch(() => null);

    // HTTP 204 → no session → Disconnected
    if (!infoData || infoData.status === 204) return { status: 'Disconnected' };

    if (infoData.server) {
      const verified = infoData.server.verified;
      const wid = infoData.server.wid || '';
      // Remove device suffix: "5518997242030:73@s.whatsapp.net" → "5518997242030"
      const cleanPhone = wid ? wid.split('@')[0].split(':')[0] : (instance.phoneNumber || '');
      const diagnostic = infoData.server.metadata?.connection_diagnostic;

      if (verified === true) {
        // Fetch real WhatsApp profile picture & name
        const profile = await fetchProfileInfo(token, wid, cleanPhone);
        return {
          status: 'Connected',
          phoneNumber: cleanPhone || instance.phoneNumber,
          wid,
          pushname: profile.pushname || infoData.server.pushname || instance.contactName || '',
          avatarUrl: profile.avatarUrl || instance.avatarUrl || '',
        };
      } else {
        if (diagnostic?.code) {
          console.log(`[QuePasa] "${instance.name}" desconectada: ${diagnostic.code}`);
        }
        return { status: 'Disconnected' };
      }
    }

    return { status: 'Disconnected' };
  } catch (err) {
    return { status: 'Disconnected' };
  }
};

