import { getOpenAIClient, getAiModel, isAiConfigured } from '@/lib/ai-client';
import { getReasoningEffort, isReasoningModel } from '@/lib/approach-message';
import { getRuntimeEnv } from '@/lib/runtime-env';

/**
 * Endpoint de diagnóstico TEMPORÁRIO para confirmar que a OPENROUTER_API_KEY
 * configurada agora está funcionando de verdade (faz uma chamada real e
 * mínima ao modelo configurado, em vez de só checar se a variável existe).
 * Pode apagar este arquivo (e a pasta test-latency) depois de usar.
 *
 * GET /api/test-latency
 */
function maskKey(value: string) {
  if (!value) return null;
  const trimmed = value.trim();
  return {
    length: trimmed.length,
    rawLength: value.length,
    preview: trimmed.length > 14 ? `${trimmed.slice(0, 10)}...${trimmed.slice(-4)}` : `${trimmed.slice(0, 4)}...`,
    hasWhitespaceOrNewline: /\s/.test(value),
    startsWithExpectedPrefix: trimmed.startsWith('sk-or-'),
  };
}

export async function GET() {
  const rawKey = getRuntimeEnv('OPENROUTER_API_KEY');
  const keyDiagnostic = maskKey(rawKey);

  if (!isAiConfigured()) {
    return Response.json({ success: false, error: 'OPENROUTER_API_KEY não configurada no .env.local.', keyDiagnostic }, { status: 400 });
  }

  const model = getAiModel();
  const start = Date.now();

  try {
    const client = getOpenAIClient();
    const params: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: 'Responda apenas com a palavra "ok".' }],
    };
    // Mesmo cuidado usado em ai.ts: modelos "reasoning" (como o gemini-3.5
    // usado aqui) gastam parte do orçamento de tokens de saída pensando
    // internamente antes de responder. Sem isso, este teste poderia falhar
    // com resposta vazia mesmo com a chave funcionando corretamente.
    const reasoningEffort = getReasoningEffort(model);
    if (reasoningEffort) params.reasoning_effort = reasoningEffort;
    if (isReasoningModel(model)) {
      params.max_completion_tokens = 20;
    } else {
      params.max_tokens = 10;
    }

    const response = await client.chat.completions.create(params as any);
    const ms = Date.now() - start;
    const content = response.choices[0]?.message?.content ?? '';
    return Response.json({ success: true, model, latencyMs: ms, response: content, keyDiagnostic });
  } catch (err: any) {
    const ms = Date.now() - start;
    return Response.json({
      success: false,
      model,
      latencyMs: ms,
      status: err?.status ?? null,
      error: err?.error?.message ?? err?.message ?? 'Falha desconhecida',
      keyDiagnostic,
    });
  }
}
