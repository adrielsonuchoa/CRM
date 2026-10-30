import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCount } from '@/lib/instagram-count';

test('parseCount: separador de milhar sem sufixo', () => {
  assert.equal(parseCount('2.573'), 2573);
  assert.equal(parseCount('2,573'), 2573);
  assert.equal(parseCount('1.234.567'), 1234567);
  assert.equal(parseCount('578'), 578);
  assert.equal(parseCount('6.016 seguindo'), 6016);
});

test('parseCount: sufixos pt-BR e en', () => {
  assert.equal(parseCount('1,5 mil'), 1500);
  assert.equal(parseCount('12 mil seguidores'), 12000);
  assert.equal(parseCount('12,3 mi'), 12300000);
  assert.equal(parseCount('1 milhão'), 1000000);
  assert.equal(parseCount('2,4 milhões'), 2400000);
  assert.equal(parseCount('1.5k'), 1500);
  assert.equal(parseCount('2M'), 2000000);
});

test('parseCount: entradas invalidas', () => {
  assert.equal(parseCount(''), null);
  assert.equal(parseCount(null), null);
  assert.equal(parseCount('seguidores'), null);
});
