import { db } from '@/db';
import { leads } from '@/db/schema';
import { generateMessageAction } from '@/app/actions/ai';

const strategies = ['Consultiva', 'Local (Maceió)', 'Focada em Problema', 'Direta'];

async function testStrategies() {
  console.log('[TEST] Iniciando testes de geração de mensagens...\n');

  try {
    // Buscar um lead de exemplo
    const leadRecord = await db.select().from(leads).limit(1);
    const lead = leadRecord[0];

    if (!lead) {
      console.error('[TEST] Nenhum lead encontrado no banco.');
      process.exit(1);
    }

    console.log(`[TEST] Lead selecionado: ${lead.businessName} (ID: ${lead.id})`);
    console.log(`[TEST] Instagram: ${lead.instagramUsername || 'Não configurado'}\n`);

    for (const strategy of strategies) {
      const start = Date.now();
      console.log(`\n[TEST] Testando estratégia: ${strategy}`);
      console.log('─'.repeat(50));

      try {
        const result = await generateMessageAction(lead.id, strategy);
        const elapsed = Date.now() - start;

        if (result.success && result.message) {
          console.log(`✓ Sucesso (${elapsed}ms)`);
          console.log(`Mensagem: ${result.message.substring(0, 100)}...`);
        } else {
          console.error(`✗ Falha: ${result.error}`);
        }
      } catch (err: any) {
        const elapsed = Date.now() - start;
        console.error(`✗ Erro (${elapsed}ms): ${err?.message}`);
        console.error(`Stack: ${err?.stack?.split('\n').slice(0, 3).join('\n')}`);
      }
    }

    console.log('\n[TEST] Testes concluídos.');
    process.exit(0);
  } catch (err: any) {
    console.error('[TEST] Erro fatal:', err?.message);
    process.exit(1);
  }
}

testStrategies();
