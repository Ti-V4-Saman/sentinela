// Validação de intervalo de datas para relatórios (Fase 6). Datas em `YYYY-MM-DD`, interpretadas no
// HORÁRIO DO BANCO (sem timezone — mesma convenção da Fase 2). Intervalo INCLUSIVO nos dois extremos:
// [from 00:00:00, (to+1dia) 00:00:00). Limite máximo de janela para evitar consultas abusivas.

export const MAX_RANGE_DAYS = 366;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');

// Valida o calendário (inclui bissexto) e retorna um Date UTC à meia-noite, ou null.
function parseYmd(s) {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}
const fmt = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} 00:00:00`;

// Retorna { fromSql, toExclusiveSql, days } ou { error }.
export function parseReportRange(q) {
  const fromStr = (q.from || '').trim();
  const toStr = (q.to || '').trim();
  if (!fromStr || !toStr) return { error: 'from e to são obrigatórios (YYYY-MM-DD)' };
  const from = parseYmd(fromStr);
  const to = parseYmd(toStr);
  if (!from || !to) return { error: 'from/to inválidos (use YYYY-MM-DD, sem timezone)' };
  if (from.getTime() > to.getTime()) return { error: 'from não pode ser maior que to' };
  const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) return { error: `intervalo máximo de ${MAX_RANGE_DAYS} dias` };
  const toExclusive = new Date(to.getTime() + 86400000);
  return { fromSql: `${fromStr} 00:00:00`, toExclusiveSql: fmt(toExclusive), days };
}
