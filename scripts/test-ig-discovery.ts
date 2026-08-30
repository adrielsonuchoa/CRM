import { chromium } from 'playwright';
import { searchInstagramUsernames } from '../src/lib/instagram-enrichment';

const names = [
  'Mercatto Restaurante e Pizzaria',
  'Restaurante Toscana',
  'ARCO RESTAURANTE',
  'Garuva Restaurante',
  'Rancho Parrilla',
  'Manguezal Restaurante',
  'Micale',
  'Mima Restaurante',
  'Pizzaria Mercatto',
  'Restaurante Garuva',
  'Mercatto Pizzaria',
  'Toscana Maceio',
  'Rancho Parrilla Maceio',
  'Arco Restaurante Maceio',
  'Manguezal Restaurante Maceio',
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results: Array<{ name: string; handles: string[] }> = [];

  for (const name of names) {
    const handles = await searchInstagramUsernames(page, name, 'Maceió');
    results.push({ name, handles: handles.slice(0, 10) });
    console.log(JSON.stringify({ name, handles: handles.slice(0, 10) }));
  }

  await browser.close();
  console.log(JSON.stringify({ total: results.length, found: results.filter((r) => r.handles.length > 0).length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
