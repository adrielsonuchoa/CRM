import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCacheKey, cached, isRedisCacheConfigured } from '@/lib/cache';

// Garante o modo em memoria, mesmo que o ambiente tenha Redis configurado
// (o cache le as variaveis na hora de cada chamada, nao no import).
delete process.env.REDIS_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

test('sem Redis configurado usa memoria', () => {
  assert.equal(isRedisCacheConfigured(), false);
});

test('buildCacheKey normaliza caixa e espacos', () => {
  assert.equal(buildCacheKey('ns', ['Pizzaria  em Maceió ']), buildCacheKey('ns', ['pizzaria em maceió']));
  assert.notEqual(buildCacheKey('ns', ['a']), buildCacheKey('outro', ['a']));
  assert.notEqual(buildCacheKey('ns', ['a', 1]), buildCacheKey('ns', ['a', 2]));
});

test('pesquisa repetida vem do cache', async () => {
  let calls = 0;
  const run = () => cached('test-repeat', ['x'], async () => { calls++; return { value: calls }; }, { ttlSeconds: 60 });
  assert.deepEqual(await run(), { value: 1 });
  assert.deepEqual(await run(), { value: 1 });
  assert.equal(calls, 1);
});

test('null tambem e cacheado (ex.: site sem Instagram)', async () => {
  let calls = 0;
  const run = () => cached('test-null', ['x'], async () => { calls++; return null; }, { ttlSeconds: 60 });
  assert.equal(await run(), null);
  assert.equal(await run(), null);
  assert.equal(calls, 1);
});

test('shouldCache false nao grava (ex.: lista vazia por bloqueio)', async () => {
  let calls = 0;
  const run = () => cached('test-skip', ['x'], async () => { calls++; return [] as string[]; }, {
    ttlSeconds: 60,
    shouldCache: (value) => value.length > 0,
  });
  await run();
  await run();
  assert.equal(calls, 2);
});

test('erro nao e cacheado', async () => {
  let calls = 0;
  const failing = () => cached('test-error', ['x'], async () => { calls++; throw new Error('falha'); }, { ttlSeconds: 60 });
  await assert.rejects(failing, /falha/);
  await assert.rejects(failing, /falha/);
  assert.equal(calls, 2);
});

test('entrada expira apos o TTL', async () => {
  let calls = 0;
  const run = () => cached('test-ttl', ['x'], async () => ++calls, { ttlSeconds: 1 });
  await run();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await run();
  assert.equal(calls, 2);
});
