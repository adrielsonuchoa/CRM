import { db } from '@/db';
import { leads } from '@/db/schema';
import { desc } from 'drizzle-orm';
import { enrichLeadViaBrowser } from '@/lib/browser-worker';

async function main() {
  const recent = (await db.select().from(leads).orderBy(desc(leads.createdAt)).limit(1))[0];
  if (!recent) {
    console.log('Nenhum lead encontrado.');
    process.exit(0);
  }
  console.log('Testando lead:', recent.id, '-', recent.businessName);
  const result = await enrichLeadViaBrowser(recent.id);
  console.log('Resultado:', result);
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro no teste:', err);
  process.exit(1);
});
