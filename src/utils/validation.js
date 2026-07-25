// Validações e máscaras compartilhadas pelos formulários.

// Nome: obrigatório e com pelo menos nome + sobrenome (2+ palavras).
export function validateFullName(value) {
  const v = (value || '').trim();
  if (!v) return 'Campo obrigatório';
  if (v.split(/\s+/).filter(Boolean).length < 2) return 'Informe nome e sobrenome para continuar';
  return '';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validateEmail(value) {
  const v = (value || '').trim();
  if (!v) return 'Campo obrigatório';
  if (!EMAIL_RE.test(v)) return 'Digite um e-mail válido, ex: nome@empresa.com';
  return '';
}

// Máscara de telefone BR em tempo real: (00) 00000-0000 (cel) ou (00) 0000-0000 (fixo).
export function maskPhone(value) {
  const d = (value || '').replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d.replace(/^(\d{0,2})/, '($1');
  if (d.length <= 6) return d.replace(/^(\d{2})(\d{0,4})/, '($1) $2');
  if (d.length <= 10) return d.replace(/^(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
  return d.replace(/^(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3');
}

export function onlyDigits(value) {
  return (value || '').replace(/\D/g, '');
}

export function validatePhone(value) {
  const d = onlyDigits(value);
  if (!d) return 'Campo obrigatório';
  if (d.length !== 10 && d.length !== 11) return 'Informe um telefone válido com DDD, ex: (31) 99999-0000';
  return '';
}

// Senha (mínimo 8) — usado no "Meus dados".
export function validatePassword(value) {
  if ((value || '').length < 8) return 'A senha precisa ter no mínimo 8 caracteres';
  return '';
}

// Traduz mensagens de erro do backend para linguagem clara ao usuário final.
// Nunca expõe SQL/stack trace cru.
export function friendlyError(message) {
  const m = (message || '').toString();
  const map = [
    [/email.*já está em uso|Já existe usuário com esse email/i, 'O e-mail informado já está em uso por outro usuário.'],
    [/Já existe tenant com esse nome/i, 'Já existe um cliente com esse nome.'],
    [/Já existe equipe com esse nome/i, 'Já existe uma equipe com esse nome neste cliente.'],
    [/instâncias vinculadas/i, 'Este cliente possui instâncias vinculadas. Remova-as antes de excluir.'],
    [/Sess(ã|a)o expirada|Token/i, 'Sua sessão expirou. Entre novamente.'],
    [/ER_|SQL|ECONNREFUSED|querying|syntax/i, 'Ocorreu um erro ao processar a solicitação. Tente novamente.'],
  ];
  for (const [re, friendly] of map) if (re.test(m)) return friendly;
  return m || 'Ocorreu um erro inesperado. Tente novamente.';
}
