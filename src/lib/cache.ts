import crypto from 'crypto';
import Redis from 'ioredis';
import { readRuntimeEnv } from '@/lib/runtime-env';

// Cache de pesquisas externas (Geoapify, sites, buscadores, Instagram) pra
// que a mesma pesquisa nao seja refeita a cada execucao do worker.
//
// Backend, em ordem de preferencia:
//   1. REDIS_URL (redis:// ou rediss://) - Redis Cloud, Docker etc., via TCP.
//   2. UPSTASH_REDIS_REST_URL/TOKEN - Upstash via REST.
//   3. Map em memoria (vale so pro processo atual).
// Qualquer falha do Redis e tratada como "cache miss" - o cache nunca
// derruba uma pesquisa.

const KEY_PREFIX = 'crm:cache:';
const MEMORY_MAX_ENTRIES = 2000;
const REDIS_TIMEOUT_MS = 2000;
// Valor guardado no lugar de null/undefined, pra conseguir cachear "nao achou".
const NULL_MARKER = '__null__';

export const CACHE_TTL = {
  HOUR: 60 * 60,
  DAY: 24 * 60 * 60,
  WEEK: 7 * 24 * 60 * 60,
  MONTH: 30 * 24 * 60 * 60,
} as const;

type MemoryEntry = { value: string; expiresAt: number };
const memoryCache = new Map<string, MemoryEntry>();

function getUpstashConfig() {
  const url = readRuntimeEnv('UPSTASH_REDIS_REST_URL').replace(/\/+$/, '');
  const token = readRuntimeEnv('UPSTASH_REDIS_REST_TOKEN');
  return url && token ? { url, token } : null;
}

export function isRedisCacheConfigured() {
  return !!readRuntimeEnv('REDIS_URL') || getUpstashConfig() !== null;
}

// Uma conexao por processo (reaproveitada entre requisicoes no Next e entre
// leads no worker). Sem fila offline: com o Redis fora do ar o comando falha
// na hora e a pesquisa segue sem cache, em vez de ficar esperando.
let tcpClient: Redis | null = null;

function getTcpClient() {
  const url = readRuntimeEnv('REDIS_URL');
  if (!url) return null;
  if (!tcpClient) {
    tcpClient = new Redis(url, {
      connectTimeout: REDIS_TIMEOUT_MS,
      commandTimeout: REDIS_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    tcpClient.on('error', (err) => console.warn('[CACHE] Redis:', err?.message ?? err));
  }
  return tcpClient;
}

async function redisCommand(command: (string | number)[]): Promise<unknown> {
  const client = getTcpClient();
  if (client) {
    if (client.status === 'wait' || client.status === 'end') await client.connect();
    const [name, ...args] = command;
    return client.call(String(name), ...args.map(String));
  }

  const config = getUpstashConfig();
  if (!config) return undefined;
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    cache: 'no-store',
  });
  const data = await response.json() as { result?: unknown; error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data.result;
}

// Monta a chave: namespace + hash das partes normalizadas, pra que
// "Pizzaria  em Maceió" e "pizzaria em maceió" caiam na mesma entrada.
export function buildCacheKey(namespace: string, parts: unknown[]) {
  const normalized = JSON.stringify(parts.map((part) => typeof part === 'string'
    ? part.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
    : part ?? null));
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
  return `${KEY_PREFIX}${namespace}:${hash}`;
}

async function readRaw(key: string): Promise<string | null> {
  if (isRedisCacheConfigured()) {
    try {
      const result = await redisCommand(['GET', key]);
      return typeof result === 'string' ? result : null;
    } catch (err: any) {
      console.warn(`[CACHE] Falha ao ler do Redis (${key}):`, err?.message ?? err);
      return null;
    }
  }
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
}

async function writeRaw(key: string, value: string, ttlSeconds: number) {
  if (isRedisCacheConfigured()) {
    try {
      await redisCommand(['SET', key, value, 'EX', Math.max(1, Math.floor(ttlSeconds))]);
    } catch (err: any) {
      console.warn(`[CACHE] Falha ao gravar no Redis (${key}):`, err?.message ?? err);
    }
    return;
  }
  if (memoryCache.size >= MEMORY_MAX_ENTRIES) {
    // Map preserva a ordem de insercao: remove a entrada mais antiga.
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

// Leitura/gravacao direta, pra quem nao cabe no formato cached() (ex.:
// screenshot de perfil gravada por um fluxo e lida por outro).
export async function getCachedValue<T>(namespace: string, keyParts: unknown[]): Promise<T | null> {
  const raw = await readRaw(buildCacheKey(namespace, keyParts));
  if (raw === null || raw === NULL_MARKER) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setCachedValue(namespace: string, keyParts: unknown[], value: unknown, ttlSeconds: number) {
  await writeRaw(buildCacheKey(namespace, keyParts), JSON.stringify(value), ttlSeconds);
}

type CachedOptions<T> = {
  ttlSeconds: number;
  // Decide se o resultado pode ser guardado (ex.: nao cachear lista vazia
  // que pode ter vindo de um bloqueio temporario do buscador).
  shouldCache?: (value: T) => boolean;
};

// Executa `fn` so se a pesquisa ainda nao estiver no cache. Erros de `fn`
// sobem normalmente e nunca sao cacheados.
export async function cached<T>(
  namespace: string,
  keyParts: unknown[],
  fn: () => Promise<T>,
  options: CachedOptions<T>,
): Promise<T> {
  const key = buildCacheKey(namespace, keyParts);
  const raw = await readRaw(key);
  if (raw !== null) {
    try {
      return (raw === NULL_MARKER ? null : JSON.parse(raw)) as T;
    } catch {
      // Entrada corrompida: ignora e refaz a pesquisa.
    }
  }

  const value = await fn();
  if (options.shouldCache && !options.shouldCache(value)) return value;
  await writeRaw(key, value === null || value === undefined ? NULL_MARKER : JSON.stringify(value), options.ttlSeconds);
  return value;
}
