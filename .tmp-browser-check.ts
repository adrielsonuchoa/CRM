import { checkChromeConnection, getWorkerStatus, runProspectingOnce } from './src/lib/browser-worker.ts';

(async () => {
  const c = await checkChromeConnection();
  console.log(JSON.stringify({ connection: c }, null, 2));

  const s = await getWorkerStatus();
  console.log(JSON.stringify({ status: s }, null, 2));

  const result = await runProspectingOnce();
  console.log(JSON.stringify({ prospecting: result }, null, 2));
})();
