import { runProspectingOnce, pauseWorker } from './src/lib/browser-worker.ts';
(async () => {
  const result = await runProspectingOnce();
  console.log(JSON.stringify({ success: result.success, message: result.message, error: result.error }, null, 2));
  const paused = await pauseWorker();
  console.log(JSON.stringify(paused, null, 2));
})();
