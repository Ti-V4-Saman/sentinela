// Tela "principal" (home) de cada papel — usada no clique do logo e no landing.
export const HOME_BY_ROLE = {
  superadmin: 'tenants',   // Clientes
  admin: 'instances',      // operacional
  gestor: 'instances',
  usuario: 'instances',
};

export const homeView = (role) => HOME_BY_ROLE[role] || 'instances';
