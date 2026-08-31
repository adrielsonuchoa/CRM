import OpenAI from 'openai';
import { db } from '../src/db';
import { leads, settings } from '../src/db/schema';
import { generateApproachMessage, type ApproachLead } from '../src/lib/approach-message';
import { messageFixtures } from './message-fixtures';
import { evaluateMessage } from './message-evaluator';

async function main() {
const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error('OPENAI_API_KEY não configurada.');
const client = new OpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL || (apiKey.startsWith('gsk_') ? 'https://api.groq.com/openai/v1' : undefined) });
const model = process.env.OPENAI_MODEL || (apiKey.startsWith('gsk_') ? 'openai/gpt-oss-20b' : 'gpt-4o-mini');
const institutional = (await db.select().from(settings).limit(1))[0]?.institutionalText ?? 'Sou representante da Sirrus em Maceió e ajudo operações de alimentação com pedidos, comandas e caixa.';
const realMode = process.argv.includes('--real');
let cases: Array<{ id: string; lead: ApproachLead }> = messageFixtures;
if (realMode) {
  const rows = await db.select().from(leads).limit(5);
  cases = rows.map((lead) => ({ id: lead.id, lead }));
}

const results: Array<{ id: string; message: string; score: number; status: string; penalties: string[] }> = [];
let promptTokens = 0;
let completionTokens = 0;
for (const fixture of cases) {
  if (results.length > 0) await new Promise((resolve) => setTimeout(resolve, 10000));
  let generated;
  try {
    generated = await generateApproachMessage({ client, model, lead: fixture.lead, institutionalText: institutional, strategy: 'Consultiva' });
  } catch (error) {
    if (!(error instanceof OpenAI.RateLimitError)) throw error;
    console.log('Limite temporário da API; aguardando 15 segundos para repetir a mesma chamada...');
    await new Promise((resolve) => setTimeout(resolve, 15000));
    generated = await generateApproachMessage({ client, model, lead: fixture.lead, institutionalText: institutional, strategy: 'Consultiva' });
  }
  const evaluation = evaluateMessage(fixture.lead, generated.message);
  promptTokens += generated.usage?.prompt_tokens ?? 0;
  completionTokens += generated.usage?.completion_tokens ?? 0;
  results.push({ id: fixture.id, message: generated.message, score: evaluation.score, status: evaluation.status, penalties: evaluation.penalties });
  console.log(`\n${fixture.id}\nMensagem: ${generated.message}\nNota: ${evaluation.score}/100 — ${evaluation.status}\nPenalidades: ${evaluation.penalties.join('; ') || 'nenhuma'}`);
}

const average = results.reduce((sum, item) => sum + item.score, 0) / Math.max(results.length, 1);
const counts = (status: string) => results.filter((item) => item.status === status).length;
const phrases = ['vi que', 'percebi que', 'gostaria de saber', 'fiquei curioso', 'sou representante', 'hoje vocês usam', 'queria entender'];
console.log('\n=== RESUMO ===');
console.log(`Modo: ${realMode ? 'leads reais read-only' : 'fixtures'}`);
console.log(`Chamadas à IA: ${results.length}`);
console.log(`Tokens: prompt=${promptTokens}, conclusão=${completionTokens}, total=${promptTokens + completionTokens}`);
console.log(`Média: ${average.toFixed(1)} | Aprovados: ${counts('APROVADO')} | Revisar: ${counts('REVISAR')} | Reprovados: ${counts('REPROVADO')}`);
for (const phrase of phrases) {
  const frequency = results.filter((item) => item.message.toLowerCase().includes(phrase)).length;
  if (frequency) console.log(`Repetição "${phrase}": ${frequency}/${results.length}`);
}
if (results.some((item) => item.status === 'REPROVADO')) process.exitCode = 1;
}

const keepProcessAlive = setInterval(() => undefined, 1000);
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => clearInterval(keepProcessAlive));
