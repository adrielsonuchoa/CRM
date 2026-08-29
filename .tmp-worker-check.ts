import { startWorker, getWorkerStatus, pauseWorker, runProspectingOnce } from './src/lib/browser-worker.ts';
(async () => {
  const startResult = await startWorker();
  console.log('START_RESULT', JSON.stringify(startResult));
  const status1 = await getWorkerStatus();
  console.log('STATUS1', JSON.stringify(status1));
  const runResult = await runProspectingOnce();
  console.log('RUN_RESULT', JSON.stringify(runResult));
  const status2 = await getWorkerStatus();
  console.log('STATUS2', JSON.stringify(status2));
  const pauseResult = await pauseWorker();
  console.log('PAUSE_RESULT', JSON.stringify(pauseResult));
})();
