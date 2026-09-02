import { db } from '@/db';
import { settings } from '@/db/schema';
import { getOpenAIClient, getAiModel, getMessageModel, isAiConfigured } from '@/lib/ai-client';
import { generateApproachMessage, type ApproachLead } from '@/lib/approach-message';

/**
 * Endpoint de diagnóstico TEMPORÁRIO para provar, com uma geração real, se o
 * "Texto Institucional" salvo em Configurações está de fato chegando no
 * prompt da IA. Pode apagar este arquivo (e a pasta test-institutional-text)
 * depois de usar.
 *
 * GET /api/test-institutional-text
 */
const sampleLead: ApproachLead = {
  businessName: 'Restaurante Exemplo Diagnóstico',
  category: 'Restaurante',
  city: 'Maceió',
  state: 'AL',
  hasDelivery: true,
};

export async function GET() {
  if (!isAiConfigured()) {
    return Response.json({ success: false, error: 'OPENROUTER_API_KEY não configurada.' }, { status: 400 });
  }

  const settingsRecord = (await db.select().from(settings).limit(1))[0];
  const institutionalText = settingsRecord?.institutionalText?.trim() || 'Não configurado.';

  try {
    const client = getOpenAIClient();
    const { message, prompt } = await generateApproachMessage({
      client,
      model: getMessageModel(),
      fallbackModel: getAiModel(),
      lead: sampleLead,
      institutionalText,
      strategy: 'Consultiva',
    });

    return Response.json({
      success: true,
      institutionalTextSalvo: institutionalText.slice(0, 300),
      institutionalTextApareceNoPrompt: prompt.user.includes(institutionalText.slice(0, 60)),
      promptEnviadoParaIA: prompt.user,
      mensagemGerada: message,
    });
  } catch (err: any) {
    return Response.json({
      success: false,
      institutionalTextSalvo: institutionalText.slice(0, 300),
      error: err?.error?.message ?? err?.message ?? 'Falha desconhecida',
    });
  }
}
