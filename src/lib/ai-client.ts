import OpenAI from 'openai';
import { getRuntimeEnv } from '@/lib/runtime-env';

// Cliente de IA compartilhado (OpenRouter). Centralizado aqui para evitar que
// cada arquivo (server actions, webhook, worker) tenha sua própria cópia da
// configuração — foi exatamente essa duplicação que deixou o webhook do
// Instagram preso na configuração antiga do Gemini direto quando migramos
// para o OpenRouter.
//
// Motivo da migração: testes reais mostraram que a chamada direta ao Gemini
// sofria picos de até 87s por causa do rate limit por conta/minuto do nível
// gratuito do Google. Passando pelo OpenRouter (capacidade paga e agregada
// de vários provedores), o mesmo modelo respondeu em ~1-2s de forma
// consistente.
export function getOpenAIClient() {
  const apiKey = getRuntimeEnv('OPENROUTER_API_KEY')?.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY não configurada. Adicione a chave no arquivo .env para usar funcionalidades de IA.');
  }
  return new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://sirrus-crm.local',
      'X-Title': 'Sirrus CRM',
    },
  });
}

export function isAiConfigured() {
  return !!getRuntimeEnv('OPENROUTER_API_KEY')?.trim();
}

export function getAiModel() {
  return getRuntimeEnv('OPENROUTER_MODEL') || 'google/gemini-3.5-flash-lite';
}

export function getMessageModel() {
  return getRuntimeEnv('OPENROUTER_MESSAGE_MODEL') || getRuntimeEnv('OPENROUTER_MODEL') || 'google/gemini-3.5-flash-lite';
}
