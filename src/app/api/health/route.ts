import { NextResponse } from 'next/server';
import { getMetaApiStatusConfig } from '@/lib/meta-api';
import { getWorkerStatus } from '@/lib/browser-worker';

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
    openaiConfigured: !!process.env.OPENAI_API_KEY?.trim(),
    metaConfigured: meta.configured,
    workerAvailable,
  });
}
