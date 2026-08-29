import { checkChromeConnection } from '@/lib/browser-worker';

async function main() {
  const res = await checkChromeConnection();
  console.log('checkChromeConnection result:', res);
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(1);
});
