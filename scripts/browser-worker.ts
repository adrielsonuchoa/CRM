import { getWorkerStatus, runProspectingOnce } from '../src/lib/browser-worker';

const intervalMs = Number(process.env.BROWSER_WORKER_INTERVAL_MS ?? 60_000);

async function main() {
  console.log('[WORKER] Processo persistente iniciado');

  while (true) {
    const status = await getWorkerStatus();

    if (status.status === 'ATIVO' || status.status === 'AGUARDANDO') {
      await runProspectingOnce();
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((error) => {
  console.error('[ERROR] Browser Worker finalizado:', error?.message ?? error);
  process.exit(1);
});
