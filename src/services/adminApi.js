// Cliente das APIs de gestão (tenants/users/teams). Usa o JWT (getAuthHeaders)
// e trata 401 (token expirado) caindo para a tela de login.
import { getAuthHeaders, handleUnauthorized } from './authApi';

async function req(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...getAuthHeaders(), ...(options.headers || {}) },
  });
  if (res.status === 401) { handleUnauthorized(); throw new Error('Sessão expirada'); }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || `Erro ${res.status}`);
  return data;
}

// ---- Perfil próprio (qualquer papel) ----
export const updateProfile = (body) => req('/api/users/me', { method: 'PATCH', body: JSON.stringify(body) });

// ---- Tenants (superadmin) ----
export const listTenants = () => req('/api/tenants');
export const createTenant = (body) => req('/api/tenants', { method: 'POST', body: JSON.stringify(body) });
export const updateTenant = (id, body) => req(`/api/tenants/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const deleteTenant = (id) => req(`/api/tenants/${id}`, { method: 'DELETE' });

// ---- Users (admin/superadmin) ----
export const listUsers = (tenantId) => req(`/api/users${tenantId ? `?tenantId=${tenantId}` : ''}`);
export const createUser = (body) => req('/api/users', { method: 'POST', body: JSON.stringify(body) });
export const updateUser = (id, body) => req(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const deleteUser = (id) => req(`/api/users/${id}`, { method: 'DELETE' });

// ---- Teams (admin/superadmin) ----
export const listTeams = (tenantId) => req(`/api/teams${tenantId ? `?tenantId=${tenantId}` : ''}`);
export const createTeam = (body) => req('/api/teams', { method: 'POST', body: JSON.stringify(body) });
export const updateTeam = (id, body) => req(`/api/teams/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const deleteTeam = (id) => req(`/api/teams/${id}`, { method: 'DELETE' });
export const listTeamInstances = (id) => req(`/api/teams/${id}/instances`);
export const linkTeamInstance = (id, instanceId) => req(`/api/teams/${id}/instances`, { method: 'POST', body: JSON.stringify({ instanceId }) });
export const unlinkTeamInstance = (id, instanceId) => req(`/api/teams/${id}/instances/${instanceId}`, { method: 'DELETE' });
export const listTeamManagers = (id) => req(`/api/teams/${id}/managers`);
export const linkTeamManager = (id, userId) => req(`/api/teams/${id}/managers`, { method: 'POST', body: JSON.stringify({ userId }) });
export const unlinkTeamManager = (id, userId) => req(`/api/teams/${id}/managers/${userId}`, { method: 'DELETE' });
