import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCsvDelimiter, escapeCsvCell, parseCsvLine, toCsv } from '@/lib/csv';

test('escapeCsvCell: aspas, separador e quebra de linha', () => {
  assert.equal(escapeCsvCell('Bar do Zé'), 'Bar do Zé');
  assert.equal(escapeCsvCell('a;b'), '"a;b"');
  assert.equal(escapeCsvCell('a,b', ','), '"a,b"');
  assert.equal(escapeCsvCell('diz "oi"'), '"diz ""oi"""');
  assert.equal(escapeCsvCell('linha1\nlinha2'), '"linha1\nlinha2"');
  assert.equal(escapeCsvCell(null), '');
  assert.equal(escapeCsvCell(42), '42');
});

test('escapeCsvCell: bloqueia formulas (CSV injection)', () => {
  assert.equal(escapeCsvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(escapeCsvCell('+5582999999999'), "'+5582999999999");
  assert.equal(escapeCsvCell('@perfil'), "'@perfil");
});

test('toCsv: BOM, CRLF e separador ;', () => {
  const csv = toCsv(['nome', 'cidade'], [['Pizzaria A', 'Maceió']]);
  assert.ok(csv.startsWith('﻿'));
  assert.equal(csv, '﻿nome;cidade\r\nPizzaria A;Maceió\r\n');
});

test('detectCsvDelimiter', () => {
  assert.equal(detectCsvDelimiter('nome;instagram;telefone'), ';');
  assert.equal(detectCsvDelimiter('nome,instagram,telefone'), ',');
  assert.equal(detectCsvDelimiter('nome'), ',');
});

test('parseCsvLine: le de volta o que toCsv exporta', () => {
  const row = ['Bar "do" Zé; Centro', '+5582999999999', '@perfil', 'normal'];
  const line = toCsv(['h1', 'h2', 'h3', 'h4'], [row]).replace(/^﻿/, '').split('\r\n')[1];
  assert.deepEqual(parseCsvLine(line, ';'), row);
});

test('parseCsvLine: CSV com virgula continua funcionando', () => {
  assert.deepEqual(parseCsvLine('Pizzaria, "Rua A, 10", 8299'), ['Pizzaria', 'Rua A, 10', '8299']);
});
