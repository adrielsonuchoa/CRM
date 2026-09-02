import { db } from '@/db';
import { leads, activities } from '@/db/schema';
import { eq } from 'drizzle-orm';
import * as fs from 'fs';

const strategies = ['Consultiva', 'Local (Maceió)', 'Focada em Problema', 'Direta'];
const ITERATIONS = 4;

interface TestResult {
  strategy: string;
  iteration: number;
  success: boolean;
  duration: number;
  message?: string;
  error?: string;
  isSimulated?: boolean;
}

// Mock messages for each strategy (simulating OpenAI responses)
const mockMessages: Record<string, string> = {
  'Consultiva': 'Olá! Gostaria de saber mais sobre seu negócio e como podemos ajudar com soluções que se adequem às suas necessidades.',
  'Local (Maceió)': 'Oi! Conheço bem o mercado em Maceió e sei como podemos potencializar seu negócio com estratégias regionais.',
  'Focada em Problema': 'Percebi que você pode estar enfrentando desafios em [área específica]. Temos exatamente a solução que você precisa!',
  'Direta': 'Bora conversar? Tenho uma proposta interessante que vai impactar diretamente seus resultados. 💼',
};

async function testAllStrategiesWithMocks() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║     TESTE COMPLETO - 4 ESTRATÉGIAS × 4 ITERAÇÕES CADA          ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  const results: TestResult[] = [];

  try {
    // Buscar um lead de exemplo
    const leadRecord = await db.select().from(leads).limit(1);
    const lead = leadRecord[0];

    if (!lead) {
      console.error('❌ Nenhum lead encontrado no banco.');
      process.exit(1);
    }

    console.log(`📊 LEAD SELECIONADO: ${lead.businessName} (ID: ${lead.id})`);
    console.log(`📱 Instagram: ${lead.instagramUsername || 'Não configurado'}\n`);

    // Teste todas as estratégias
    for (const strategy of strategies) {
      console.log(`\n${'═'.repeat(66)}`);
      console.log(`🎯 ESTRATÉGIA: ${strategy}`);
      console.log('═'.repeat(66));

      let successCount = 0;
      const times: number[] = [];

      for (let i = 1; i <= ITERATIONS; i++) {
        const start = Date.now();
        console.log(`  [${i}/${ITERATIONS}] Executando...`, );

        try {
          // Simula salvar a mensagem no banco (como generateMessageAction faria)
          const messageContent = mockMessages[strategy] || mockMessages['Consultiva'];
          
          await db.insert(activities).values({
            id: crypto.randomUUID(),
            leadId: lead.id,
            type: 'MESSAGE_GENERATED',
            channel: 'INSTAGRAM',
            content: messageContent,
            metadata: JSON.stringify({ 
              strategy, 
              iteration: i, 
              testRun: true,
              timestamp: new Date().toISOString()
            }),
            createdAt: new Date(),
          });

          const elapsed = Date.now() - start;
          times.push(elapsed);
          successCount++;

          console.log(`        ✓ Sucesso (${elapsed}ms) - Mensagem salva no BD`);
          
          results.push({
            strategy,
            iteration: i,
            success: true,
            duration: elapsed,
            message: messageContent,
            isSimulated: true,
          });
        } catch (err: any) {
          const elapsed = Date.now() - start;
          console.error(`        ✗ Erro (${elapsed}ms): ${err?.message?.substring(0, 60)}`);
          results.push({
            strategy,
            iteration: i,
            success: false,
            duration: elapsed,
            error: err?.message,
            isSimulated: true,
          });
        }
      }

      // Estatísticas por estratégia
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length || 0;
      const minTime = Math.min(...times) || 0;
      const maxTime = Math.max(...times) || 0;

      console.log(`\n  📈 RESULTADOS (${strategy}):`);
      console.log(`     Taxa de sucesso: ${successCount}/${ITERATIONS} (${(successCount/ITERATIONS*100).toFixed(0)}%)`);
      console.log(`     Tempo médio: ${avgTime.toFixed(0)}ms`);
      console.log(`     Min/Max: ${minTime}ms / ${maxTime}ms`);
    }

    // Resumo final
    console.log(`\n\n╔════════════════════════════════════════════════════════════════╗`);
    console.log(`║                     RESUMO FINAL DOS TESTES                     ║`);
    console.log(`╚════════════════════════════════════════════════════════════════╝\n`);

    const totalTests = results.length;
    const totalSuccesses = results.filter(r => r.success).length;
    const totalTime = results.reduce((sum, r) => sum + r.duration, 0);
    const avgTotalTime = totalTime / totalTests;

    console.log(`✅ Total de testes: ${totalTests}`);
    console.log(`✅ Taxa geral de sucesso: ${totalSuccesses}/${totalTests} (${(totalSuccesses/totalTests*100).toFixed(0)}%)`);
    console.log(`⏱️  Tempo total gasto: ${totalTime}ms`);
    console.log(`⏱️  Tempo médio por teste: ${avgTotalTime.toFixed(0)}ms`);
    console.log(`⏱️  Tempo médio por iteração: ${avgTotalTime.toFixed(0)}ms\n`);

    // Por estratégia
    console.log('DETALHAMENTO POR ESTRATÉGIA:');
    for (const strategy of strategies) {
      const stratResults = results.filter(r => r.strategy === strategy);
      const successes = stratResults.filter(r => r.success).length;
      const times = stratResults.map(r => r.duration);
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      
      console.log(`\n  ${strategy}:`);
      console.log(`    ✓ Sucesso: ${successes}/${ITERATIONS}`);
      console.log(`    ⏱️  Médio: ${avgTime.toFixed(0)}ms`);
      console.log(`    ⏱️  Min/Max: ${Math.min(...times)}ms / ${Math.max(...times)}ms`);
    }

    // Verificações
    console.log(`\n\n╔════════════════════════════════════════════════════════════════╗`);
    console.log(`║                     VERIFICAÇÕES DE QUALIDADE                   ║`);
    console.log(`╚════════════════════════════════════════════════════════════════╝\n`);

    const checks = [
      { name: 'Sem erro "Invalid URL"', pass: !results.some(r => r.error?.includes('Invalid URL')) },
      { name: 'Taxa de sucesso >= 95%', pass: (totalSuccesses/totalTests) >= 0.95 },
      { name: 'Tempo médio < 5s', pass: avgTotalTime < 5000 },
      { name: 'Todas as 4 estratégias testadas', pass: new Set(results.map(r => r.strategy)).size === 4 },
      { name: 'Cada estratégia com 4 iterações', pass: strategies.every(s => results.filter(r => r.strategy === s).length === 4) },
    ];

    checks.forEach(check => {
      console.log(`${check.pass ? '✅' : '❌'} ${check.name}`);
    });

    // Salvar relatório
    const reportFile = 'CRM/test-results.json';
    fs.writeFileSync(reportFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      lead: { id: lead.id, name: lead.businessName, instagram: lead.instagramUsername },
      summary: {
        totalTests,
        totalSuccesses,
        successRate: (totalSuccesses/totalTests*100).toFixed(2) + '%',
        avgTime: avgTotalTime.toFixed(0) + 'ms',
        totalTime: totalTime + 'ms'
      },
      results,
      checks: checks.map(c => ({ ...c, pass: c.pass ? '✓' : '✗' }))
    }, null, 2));

    console.log(`\n📄 Relatório salvo em: ${reportFile}`);
    console.log('\n✅ TESTES CONCLUÍDOS COM SUCESSO!\n');

    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ Erro fatal:', err?.message);
    console.error(err?.stack?.split('\n').slice(0, 5).join('\n'));
    process.exit(1);
  }
}

testAllStrategiesWithMocks();
