const JWT_KEY = 'sentinela_jwt';

export async function login(email, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('Falha no login');
  const data = await res.json();
  localStorage.setItem(JWT_KEY, data.token);
  return data;
}

export function getToken() { return localStorage.getItem(JWT_KEY); }
export function logout() { localStorage.removeItem(JWT_KEY); }

export function getAuthHeaders() {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
