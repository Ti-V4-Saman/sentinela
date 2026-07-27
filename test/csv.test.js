import { describe, it, expect } from 'vitest';
import { csvCell, toCsv, safeFilename } from '../server/csv.js';

describe('csv — proteção contra injection e formatação', () => {
  it('neutraliza células que começam com = + - @ (fórmula) com prefixo aspa', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+cmd')).toBe("'+cmd");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });
  it('escapa aspas, ponto-e-vírgula e quebras de linha', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('diz "oi"')).toBe('"diz ""oi"""');
    expect(csvCell('linha1\nlinha2')).toBe('"linha1\nlinha2"');
  });
  it('valores simples e nulos passam sem alteração', () => {
    expect(csvCell('Ana')).toBe('Ana');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
  it('uma fórmula perigosa com ; é prefixada E citada', () => {
    // começa com '=' (prefixa aspa) e contém ';' (cita)
    expect(csvCell('=1;2')).toBe('"\'=1;2"');
  });
  it('toCsv inclui BOM, delimitador ; e CRLF', () => {
    const out = toCsv(['A', 'B'], [['1', '2'], ['=x', 'y']]);
    expect(out.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(out).toContain('A;B\r\n');
    expect(out).toContain("'=x;y\r\n");     // injection neutralizada na linha
  });
  it('safeFilename remove caracteres perigosos e path traversal', () => {
    expect(safeFilename('../etc/passwd')).toBe('.._etc_passwd'); // sem separador → sem traversal
    expect(safeFilename('relatorio 2026/07.csv')).toBe('relatorio_2026_07.csv');
    expect(safeFilename('')).toBe('export');
  });
});
