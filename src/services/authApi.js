const JWT_KEY = 'sentinela_jwt';
const USER_KEY = 'sentinela_user';

export async function login(email, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Falha no login');
  }
  const data = await res.json();
  localStorage.setItem(JWT_KEY, data.token);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  return data;
}

export function getToken() { return localStorage.getItem(JWT_KEY); }

export function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); }
  catch { return null; }
}

export function getRole() { return getUser()?.role || null; }
export function isAuthenticated() { return !!getToken(); }
export function isAdmin() { const r = getRole(); return r === 'admin' || r === 'superadmin'; }

export function logout() {
  localStorage.removeItem(JWT_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getAuthHeaders() {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// Chamado pelas camadas de API quando uma resposta vem 401: token expirado/inválido.
// Limpa a sessão e recarrega para cair na tela de login.
export function handleUnauthorized() {
  logout();
  if (typeof window !== 'undefined') window.location.reload();
}
