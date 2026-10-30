export type CsvDelimiter = ',' | ';';

// Celula que comeca com = + - @ (ou tab/CR) vira formula ao abrir no
// Excel/Sheets ("CSV injection"). Prefixar com apostrofo faz a planilha
// tratar como texto.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: unknown, delimiter: CsvDelimiter = ';'): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (text.includes('"') || text.includes(delimiter) || /[\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

// ";" por padrao: e o separador que o Excel em portugues abre direto em
// colunas. O BOM faz o Excel ler os acentos como UTF-8.
export function toCsv(headers: string[], rows: unknown[][], delimiter: CsvDelimiter = ';'): string {
  const lines = [headers, ...rows].map((row) => row.map((cell) => escapeCsvCell(cell, delimiter)).join(delimiter));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// Detecta o separador pela linha de cabecalho (o importador aceita tanto o
// CSV do Excel BR quanto o padrao com virgula).
export function detectCsvDelimiter(headerLine: string): CsvDelimiter {
  const semicolons = (headerLine.match(/;/g) ?? []).length;
  const commas = (headerLine.match(/,/g) ?? []).length;
  return semicolons > commas ? ';' : ',';
}

// Desfaz o apostrofo que escapeCsvCell poe na frente de "+55..." etc., pra
// um CSV exportado pelo CRM poder ser reimportado sem sujar os dados.
function unescapeFormulaGuard(cell: string) {
  return cell.replace(/^'(?=[=+\-@])/, '');
}

export function parseCsvLine(line: string, delimiter: CsvDelimiter = ','): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') { cell += '"'; index++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === delimiter && !quoted) { cells.push(unescapeFormulaGuard(cell.trim())); cell = ''; continue; }
    cell += char;
  }
  cells.push(unescapeFormulaGuard(cell.trim()));
  return cells;
}
