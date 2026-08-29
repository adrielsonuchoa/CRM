import { db } from '@/db';
import { leads } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';
import { enrichLeadViaBrowser } from '@/lib/browser-worker';

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('Iniciando enriquecimento em múltiplos leads...');

  // Busca leads recentes da categoria Restaurante para diversidade
  const candidates = await db.select().from(leads)
    .where(eq(leads.category, 'Restaurante'))
    .orderBy(desc(leads.createdAt))
    .limit(30);

  if (!candidates || candidates.length === 0) {
    console.log('Nenhum lead candidato encontrado.');
    process.exit(0);
  }

  let confirmed = 0;
  const attempts: Array<{ id: string; name: string; result: any }> = [];

  for (const lead of candidates) {
    if (confirmed >= 5) break;
    console.log(`Tentando enriquecer: ${lead.id} - ${lead.businessName}`);
    try {
      const res = await enrichLeadViaBrowser(lead.id);
      console.log('Resultado:', res);
      attempts.push({ id: lead.id, name: lead.businessName, result: res });
      if (res.success && res.username) {
        confirmed++;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Erro ao enriquecer lead:', message);
      attempts.push({ id: lead.id, name: lead.businessName, result: { success: false, error: message } });
    }

    // Aguarda um pouco entre tentativas para não acionar proteções
    await sleep(3000);
  }

  console.log(`Enriquecimentos confirmados: ${confirmed}`);
  console.log('Resumo das tentativas:', attempts);
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro no script:', err);
  process.exit(1);
});
