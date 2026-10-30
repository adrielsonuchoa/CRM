import { NextResponse } from 'next/server';
import { getMetaApiStatusConfig } from '@/lib/meta-api';
import { getWorkerStatus } from '@/lib/browser-worker';
import { isRuntimeEnvSet } from '@/lib/runtime-env';
import { isRedisCacheConfigured } from '@/lib/cache';

export async function GET() {
  const meta = getMetaApiStatusConfig();
  let workerAvailable = false;

  try {
    const worker = await getWorkerStatus();
    workerAvailable = worker.chromeConnected;
  } catch {
    workerAvailable = false;
  }

  return NextResponse.json({
    app: true,
    aiConfigured: isRuntimeEnvSet('OPENROUTER_API_KEY'),
    metaConfigured: meta.configured,
    cacheRedisConfigured: isRedisCacheConfigured(),
    workerAvailable,
  });
}
