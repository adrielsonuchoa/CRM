import { db } from './src/db';
import { leads } from './src/db/schema';

(async () => {
  try {
    console.log('[TEST] Iniciando teste direto de IA');
    
    // Buscar um lead em DESCOBERTO
    const lead = await db
      .select()
      .from(leads)
      .where(l => l.pipelineStage === 'DESCOBERTO')
      .limit(1);
    
    if (!lead.length) {
      console.log('[ERROR] Nenhum lead DESCOBERTO encontrado');
      process.exit(1);
    }
    
    const testLead = lead[0];
    console.log('[TEST] Lead selecionado:', testLead.businessName);
    
    // Teste 1: Verificar se OpenAI está configurada
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    console.log('[TEST] API Key configurada?', !!apiKey);
    console.log('[TEST] API Key tipo:', apiKey?.substring(0, 10) + '***');
    
    // Teste 2: Importar a função de IA
    console.log('[TEST] Importando analyzeLeadAction...');
    const { analyzeLeadAction } = await import('./src/app/actions/ai');
    console.log('[TEST] Função importada com sucesso');
    
    // Teste 3: Executar análise
    console.log('[TEST] Executando análise de IA...');
    const startTime = Date.now();
    const result = await analyzeLeadAction(testLead.id);
    const duration = Date.now() - startTime;
    
    console.log('[TEST] Resultado recebido em', duration, 'ms');
    console.log('[TEST] Sucesso?', result.success);
    console.log('[TEST] Resultado:', JSON.stringify(result, null, 2));
    
  } catch (err: any) {
    console.error('[ERROR]', err?.message ?? err);
    console.error('[STACK]', err?.stack ?? '');
    process.exit(1);
  }
})();
