// Cliente da API de conversas (Fase 2). Somente leitura. JWT + tratamento de 401.
import { getAuthHeaders, handleUnauthorized } from './authApi';

async function req(path, signal) {
  const res = await fetch(path, { headers: getAuthHeaders(), signal });
  if (res.status === 401) { handleUnauthorized(); throw new Error('Sessão expirada'); }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || `Erro ${res.status}`);
  return data;
}

function qs(params) {
  const u = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  });
  const s = u.toString();
  return s ? `?${s}` : '';
}

// Aceitam AbortSignal para cancelar ao trocar de conversa/filtro.
export const listChats = (params, signal) => req(`/api/chats${qs(params)}`, signal);
export const listMessages = (refOrId, params, signal) =>
  req(`/api/chats/${encodeURIComponent(refOrId)}/messages${qs(params)}`, signal);
