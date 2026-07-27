// Geração de CSV segura para exportações (Fase 6).
//
// - Proteção contra CSV injection: células que começam com = + - @ (ou TAB/CR) são prefixadas com `'`
//   para não serem interpretadas como fórmula pelo Excel/Sheets.
// - Encoding compatível com Excel pt-BR: UTF-8 com BOM + delimitador `;` (padrão da locale pt-BR).
// - Aspas/《;》/quebras de linha são escapadas com aspas duplas.

const RISKY = /^[=+\-@\t\r]/;

export function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (RISKY.test(s)) s = `'${s}`;
  if (/[";\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers, rows, { delimiter = ';' } = {}) {
  const bom = '﻿';
  const lines = [headers.map(csvCell).join(delimiter)];
  for (const r of rows) lines.push(r.map(csvCell).join(delimiter));
  return bom + lines.join('\r\n') + '\r\n';
}

// Nome de arquivo seguro (só [A-Za-z0-9._-]); evita path traversal / cabeçalhos maliciosos.
export function safeFilename(base) {
  const clean = String(base || '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 80);
  return clean || 'export';
}
