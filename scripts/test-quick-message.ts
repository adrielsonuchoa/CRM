import OpenAI from 'openai';
import { generateApproachMessage } from '../src/lib/approach-message';
import { readRuntimeEnv } from '../src/lib/runtime-env';

async function main() {
  const client = new OpenAI({
    apiKey: readRuntimeEnv('GEMINI_API_KEY'),
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  });

  const lead = {
    businessName: 'Manguezal Restaurante',
    category: 'Restaurante',
    city: 'Maceió',
    neighborhood: 'Ponta Verde',
    hasDelivery: true,
  };

  const start = Date.now();
  const result = await generateApproachMessage({
    client,
    model: readRuntimeEnv('GEMINI_MODEL') || 'gemini-3.6-flash',
    lead,
    institutionalText: 'Sou o Adrielson, da Sirrus Sistemas aqui de Maceió, e trabalho ajudando estabelecimentos a simplificarem a rotina de pedidos, comandas e caixa.',
    strategy: 'Direta',
  });

  console.log('Time:', Date.now() - start, 'ms');
  console.log('Message:', result.message);
  console.log('Complete:', result.message.endsWith('?'));
  console.log('Length:', result.message.length);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
