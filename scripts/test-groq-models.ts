import { OpenAI } from 'openai';
import { getRuntimeEnv } from '@/lib/runtime-env';

async function checkAvailableModels() {
  console.log('[DEBUG] Testando disponibilidade de modelos Groq...\n');

  const apiKey = getRuntimeEnv('OPENAI_API_KEY');
  console.log(`[DEBUG] API Key carregada: ${apiKey?.substring(0, 20)}...\n`);

  const groqClient = new OpenAI({
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1',
  });

  // Testar alguns modelos conhecidos
  const modelsToTest = [
    'deepseek-r1-distill-llama-70b',
    'llama-3.3-70b-versatile',
    'llama-3.3-70b-specdec',
    'deepseek-r1-distill-qwen-32b',
  ];

  for (const model of modelsToTest) {
    try {
      console.log(`🔍 Testando: ${model}`);
      
      // Faz uma chamada mínima para testar
      const response = await groqClient.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'teste' }],
        max_tokens: 10,
      });

      console.log(`  ✅ DISPONÍVEL! Response: ${response.choices[0].message.content?.substring(0, 50)}\n`);
      break; // Se funcionou, não precisa testar os outros
    } catch (err: any) {
      console.log(`  ❌ Erro: ${err?.error?.message || err?.message}\n`);
    }
  }

  console.log('[DEBUG] Teste de modelos concluído.');
}

checkAvailableModels().catch(console.error);
