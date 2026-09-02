'use server';

import type OpenAI from 'openai';
import { z } from 'zod';
import { db } from '@/db';
import { activities, leads, settings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { generateApproachMessage, getReasoningEffort, isReasoningModel } from '@/lib/approach-message';
import { getOpenAIClient as getOpenAI, getAiModel, getMessageModel } from '@/lib/ai-client';

const ScoreSchema = z.object({
  score: z.number().describe('Pontuação de 0 a 100.'),
  qualification: z.enum(['ALTA PRIORIDADE', 'BOA OPORTUNIDADE', 'MÉDIA PRIORIDADE', 'BAIXA PRIORIDADE']),
  reasons: z.array(z.string()).describe('Motivos factuais para a pontuação'),
  possibleNeeds: z.array(z.string()).describe('Necessidades inferidas (PDV, comandas, mesas, estoque, delivery)'),
  confidence: z.number().describe('Confiança de 0.0 a 1.0'),
  summary: z.string().describe('Resumo factual do estabelecimento, separando fatos de inferências'),
});

type Qualification = z.infer<typeof ScoreSchema>['qualification'];

function extractJsonObject(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return JSON.parse(trimmed);
}

function normalizeLeadAnalysisPayload(raw: unknown) {
  const source = (typeof raw === 'object' && raw ? raw as Record<string, unknown> : {}) as Record<string, unknown>;
  const payload = (source.result && typeof source.result === 'object' ? source.result as Record<string, unknown> : source) as Record<string, unknown>;

  const reasons = Array.isArray(payload.reasons)
    ? payload.reasons.map((item) => typeof item === 'string' ? item : String(item)).filter(Boolean)
    : [];

  const possibleNeeds = Array.isArray(payload.possibleNeeds)
    ? payload.possibleNeeds.map((item) => typeof item === 'string' ? item : String(item)).filter(Boolean)
    : [];

  const qualification = typeof payload.qualification === 'string' && ['ALTA PRIORIDADE', 'BOA OPORTUNIDADE', 'MÉDIA PRIORIDADE', 'BAIXA PRIORIDADE'].includes(payload.qualification)
    ? payload.qualification
    : 'MÉDIA PRIORIDADE';

  const score = Number(payload.score ?? 0);
  const confidence = Number(payload.confidence ?? (score >= 70 ? 0.8 : score >= 40 ? 0.6 : 0.4));
  const summary = typeof payload.summary === 'string' && payload.summary.trim()
    ? payload.summary.trim()
    : 'Resumo da IA indisponível; avaliação baseada nos dados do lead.';

  return {
    score: Number.isFinite(score) ? score : 0,
    qualification,
    reasons: reasons.length ? reasons : ['Dados limitados para uma avaliação detalhada.'],
    possibleNeeds: possibleNeeds.length ? possibleNeeds : ['PDV'],
    confidence: Number.isFinite(confidence) ? confidence : 0.5,
    summary,
  };
}

// Helper: timeout wrapper with AbortController
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeoutPromise = new Promise<T>((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout apos ${timeoutMs}ms`)), timeoutMs)
  );
  return Promise.race([promise, timeoutPromise]);
}

// Helper: Fast fallback scoring based on lead characteristics
function getFallbackScore(lead: typeof leads.$inferSelect): { score: number; qualification: Qualification; reasons: string[] } {
  let score = 30;
  const reasons: string[] = ['Analise de IA indisponivel; score baseado em dados basicos.'];

  if (lead.followers && lead.followers > 5000) {
    score += 20;
    reasons.push('Presenca digital forte (5k+ seguidores).');
  }
  if (lead.hasDelivery) {
    score += 15;
    reasons.push('Operacoes de delivery aumentam complexidade operacional.');
  }
  if (lead.hasDiningRoom) {
    score += 10;
    reasons.push('Salao exige gestao de mesas e comandas.');
  }
  if (lead.hasWaiters) {
    score += 10;
    reasons.push('Presenca de garcons sugere operacoes complexas.');
  }
  if (lead.rating && lead.rating >= 4.5) {
    score += 5;
    reasons.push('Alta avaliacao (reputacao consolidada).');
  }

  score = Math.min(100, score);
  const qualification = score >= 70 ? 'ALTA PRIORIDADE' : score >= 50 ? 'BOA OPORTUNIDADE' : score >= 30 ? 'MÉDIA PRIORIDADE' : 'BAIXA PRIORIDADE';

  return { score, qualification, reasons };
}

export async function analyzeLeadAction(leadId: string, retryCount: number = 0): Promise<{ success: boolean; result?: z.infer<typeof ScoreSchema>; error?: string; fallback?: boolean }> {
  try {
    const openai = getOpenAI();
    const leadRecord = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    const lead = leadRecord[0];
    if (!lead) throw new Error('Lead não encontrado.');

    const prompt = `Analise o seguinte estabelecimento para o CRM da Sirrus em Maceió.
O objetivo da Sirrus é vender sistemas de gestão para restaurantes, bares, pizzarias e similares (PDV, comandas, mesas, estoque, delivery).
Forneça um Lead Score de 0 a 100 indicando a aderência ao perfil.

IMPORTANTE: Utilize APENAS as informações fornecidas. Não invente dados. Se não souber, indique "unknown".

Dados do Lead:
Nome: ${lead.businessName}
Categoria: ${lead.category ?? 'Não informado'}${lead.subcategory ? ` - ${lead.subcategory}` : ''}
Instagram: ${lead.instagramUsername ?? 'Não informado'} (${lead.followers ?? 'desconhecido'} seguidores)
Bairro: ${lead.neighborhood ?? 'Não informado'}
Cidade/região: ${lead.city ?? 'Não informado'}${lead.state ? ` / ${lead.state}` : ''}
Endereço: ${lead.address ?? 'Não informado'}
Website: ${lead.website ?? 'Não informado'}
Avaliação Google: ${lead.rating ?? 'Não informado'} (${lead.reviewCount ?? 'não informado'} avaliações)
Delivery: ${lead.hasDelivery ? 'Sim' : lead.hasDelivery === false ? 'Não' : 'Desconhecido'}
Salão: ${lead.hasDiningRoom ? 'Sim' : lead.hasDiningRoom === false ? 'Não' : 'Desconhecido'}
Garçons: ${lead.hasWaiters ? 'Sim' : lead.hasWaiters === false ? 'Não' : 'Desconhecido'}
Múltiplas Unidades: ${lead.hasMultipleUnits ? 'Sim' : 'Não'}
Notas: ${lead.notes ?? 'Sem notas.'}
Informações institucionais da Sirrus: ${((await db.select().from(settings).limit(1))[0]?.institutionalText ?? 'Não configuradas')}`;

    // Call IA with 30-second timeout
    let rawContent: string | null = null;
    try {
      const scoreModel = getAiModel();
      const scoreParams: Record<string, unknown> = {
        model: scoreModel,
        messages: [
          { role: 'system', content: 'Você é um especialista em vendas da Sirrus, sistemas de gestão para food service. Nunca invente dados não fornecidos. Responda em JSON válido correspondente ao schema do lead.' },
          { role: 'user', content: prompt + '\n\nRetorne a resposta estritamente no formato JSON com as chaves: score (número 0-100), qualification ("ALTA PRIORIDADE" | "BOA OPORTUNIDADE" | "MÉDIA PRIORIDADE" | "BAIXA PRIORIDADE"), reasons (array de strings), possibleNeeds (array de strings: PDV, comandas, mesas, estoque, delivery), confidence (número 0.0-1.0), summary (string).' },
        ],
        response_format: { type: 'json_object' },
      };
      // Modelos "reasoning" (ex.: Gemini 3.x/2.5) gastam tokens de saída com
      // "thinking" interno antes de escrever o JSON final. Sem limitar isso
      // com reasoning_effort, o modelo pode consumir a maior parte do
      // orçamento pensando e devolver a resposta cortada, além de demorar
      // mais para responder.
      const scoreReasoningEffort = getReasoningEffort(scoreModel);
      if (scoreReasoningEffort) scoreParams.reasoning_effort = scoreReasoningEffort;
      if (isReasoningModel(scoreModel)) {
        scoreParams.max_completion_tokens = 2048;
      } else {
        scoreParams.max_tokens = 2048;
      }

      const response = await withTimeout(
        openai.chat.completions.create(scoreParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming),
        40000 // 40-second timeout (folga para latencia de rede + compilacao a frio do Next dev)
      );
      rawContent = response.choices[0].message.content;
    } catch (timeoutErr: any) {
      if (retryCount < 2) {
        console.warn(`[AI] Timeout/erro na tentativa ${retryCount + 1}, tentando novamente...`, timeoutErr?.message);
        await new Promise(r => setTimeout(r, 1000 * (retryCount + 1))); // Backoff
        return analyzeLeadAction(leadId, retryCount + 1);
      } else {
        console.warn(`[AI] Falha apos 3 tentativas para lead ${leadId}. Usando fallback.`, timeoutErr?.message);
        // Use fallback scoring
        const fallback = getFallbackScore(lead);
        const result = {
          score: fallback.score,
          qualification: fallback.qualification,
          reasons: fallback.reasons,
          possibleNeeds: lead.category?.toLowerCase().includes('pizzaria') ? ['PDV', 'comandas'] : ['PDV', 'estoque'],
          confidence: 0.3,
          summary: `Analise rapida via fallback. ${fallback.reasons.join(' ')}`,
        };

        const now = new Date();
        await db.update(leads)
          .set({
            leadScore: result.score,
            qualificationStatus: result.qualification,
            painPoints: JSON.stringify(result.possibleNeeds),
            pipelineStage: lead.pipelineStage === 'NOVO' || lead.pipelineStage === 'PESQUISANDO' ? (result.score >= 50 ? 'QUALIFICADO' : 'DESCARTADO') : lead.pipelineStage,
            updatedAt: now,
          })
          .where(eq(leads.id, leadId));

        await db.insert(activities).values({
          id: crypto.randomUUID(),
          leadId,
          type: 'AI_ANALYSIS',
          content: `[FALLBACK] Score: ${result.score}/100 (${result.qualification})\n\nResumo: ${result.summary}\n\nMotivos: ${result.reasons.join(', ')}\n\nNecessidades: ${result.possibleNeeds.join(', ')}`,
          metadata: JSON.stringify({ score: result.score, qualification: result.qualification, confidence: result.confidence, reasons: result.reasons, possibleNeeds: result.possibleNeeds, fallback: true }),
          createdAt: now,
        });

        return { success: true, result, fallback: true };
      }
    }

    if (!rawContent) throw new Error('Falha ao obter resposta da IA.');

    let parsed: unknown;
    try {
      parsed = extractJsonObject(rawContent);
    } catch {
      const fallbackJson = rawContent.match(/\{[\s\S]*\}/)?.[0];
      if (!fallbackJson) throw new Error('Resposta da IA não está em JSON válido.');
      parsed = extractJsonObject(fallbackJson);
    }

    const normalized = normalizeLeadAnalysisPayload(parsed);
    const result = ScoreSchema.parse({
      score: Math.min(100, Math.max(0, normalized.score)),
      qualification: normalized.qualification,
      reasons: normalized.reasons,
      possibleNeeds: normalized.possibleNeeds,
      confidence: Math.min(1, Math.max(0, normalized.confidence)),
      summary: normalized.summary,
    });

    const now = new Date();
    await db.update(leads)
      .set({
        leadScore: result.score,
        qualificationStatus: result.qualification,
        painPoints: JSON.stringify(result.possibleNeeds),
        pipelineStage: lead.pipelineStage === 'NOVO' || lead.pipelineStage === 'PESQUISANDO' ? 'QUALIFICADO' : lead.pipelineStage,
        updatedAt: now,
      })
      .where(eq(leads.id, leadId));

    await db.insert(activities).values({
      id: crypto.randomUUID(),
      leadId,
      type: 'AI_ANALYSIS',
      content: `Score: ${result.score}/100 (${result.qualification})\n\nResumo: ${result.summary}\n\nMotivos: ${result.reasons.join(', ')}\n\nNecessidades: ${result.possibleNeeds.join(', ')}`,
      metadata: JSON.stringify({ score: result.score, qualification: result.qualification, confidence: result.confidence, reasons: result.reasons, possibleNeeds: result.possibleNeeds }),
      createdAt: now,
    });

    return { success: true, result };
  } catch (error: any) {
    console.error('Error analyzing lead:', error);
    // Return fallback on final error
    try {
      const leadRecord = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
      const lead = leadRecord[0];
      if (lead) {
        const fallback = getFallbackScore(lead);
        const result = {
          score: fallback.score,
          qualification: fallback.qualification,
          reasons: fallback.reasons,
          possibleNeeds: ['PDV', 'estoque'],
          confidence: 0.2,
          summary: 'Analise indisponivel; fallback aplicado.',
        };
        const now = new Date();
        await db.update(leads)
          .set({
            leadScore: result.score,
            qualificationStatus: result.qualification,
            painPoints: JSON.stringify(result.possibleNeeds),
            pipelineStage: 'DESCARTADO',
            updatedAt: now,
          })
          .where(eq(leads.id, leadId));
        return { success: true, result, fallback: true };
      }
    } catch (fallbackErr: any) {
      console.error('Fallback also failed:', fallbackErr);
    }
    return { success: false, error: error.message };
  }
}

export async function generateMessageAction(leadId: string, strategy: string = 'Consultiva') {
  try {
    const openai = getOpenAI();
    const leadRecord = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    const lead = leadRecord[0];
    if (!lead) throw new Error('Lead não encontrado.');

    const settingsRecord = await db.select().from(settings).limit(1);
    const institutionalText = settingsRecord[0]?.institutionalText?.trim() || 'Não configurado.';

    const { message } = await withTimeout(
      generateApproachMessage({
        client: openai,
        model: getMessageModel(),
        fallbackModel: getAiModel(),
        lead,
        institutionalText,
        strategy,
      }),
      45000, // ampliado de 25s: sobra para o retry interno (2 tentativas) + latencia de rede
    );

    await db.insert(activities).values({
      id: crypto.randomUUID(),
      leadId,
      type: 'MESSAGE_GENERATED',
      channel: 'INSTAGRAM',
      content: message,
      metadata: JSON.stringify({ strategy }),
      createdAt: new Date(),
    });

    return { success: true, message };
  } catch (error: any) {
    console.error('Error generating message:', error);
    return { success: false, error: error.message };
  }
}

export async function disambiguateInstagramCandidates(
  lead: {
    businessName: string;
    city: string | null;
    neighborhood: string | null;
    category: string | null;
    phone: string | null;
    website: string | null;
  },
  candidates: Array<{
    username: string;
    displayName: string | null;
    bio: string | null;
    category: string | null;
    followers: number | null;
    postsCount: number | null;
    website: string | null;
    phone: string | null;
    score: number;
  }>
): Promise<{ matched: boolean; username: string | null; confidence: number; reason: string }> {
  try {
    const openai = getOpenAI();
    const prompt = `Decida qual perfil do Instagram (se houver) corresponde exatamente ao seguinte estabelecimento procurado.

Estabelecimento Procurado:
- Nome Comercial: ${lead.businessName}
- Cidade/Região: ${lead.city ?? 'Não informado'} (${lead.neighborhood ?? ''})
- Categoria/Ramo: ${lead.category ?? 'Alimentação'}
- Telefone Esperado: ${lead.phone ?? 'Não informado'}
- Website Esperado: ${lead.website ?? 'Não informado'}

Candidatos Encontrados:
${candidates.map((c, i) => `
Candidato ${i + 1}:
- @username: ${c.username}
- Nome de exibição: ${c.displayName ?? 'Não informado'}
- Bio: ${c.bio ?? 'Sem bio'}
- Categoria comercial: ${c.category ?? 'Não informado'}
- Seguidores: ${c.followers ?? 'Desconhecido'}
- Publicações: ${c.postsCount ?? 'Desconhecido'}
- Site na bio: ${c.website ?? 'Não informado'}
- Telefone na bio: ${c.phone ?? 'Não informado'}
- Score de afinidade local: ${c.score}
`).join('\n')}

Regras de Decisão:
1. Compare os dados do estabelecimento com os perfis candidatos.
2. Se algum candidato for uma correspondência real e inequívoca do estabelecimento (com base em similaridade de nome, ramo de atuação e localização geográfica compatível), selecione-o.
3. Fique extremamente atento a falsos positivos (ex: franquias em outras cidades, lojas de outro segmento com o mesmo nome, perfis pessoais ou de fã, etc. Se a cidade ou segmento forem incompatíveis, NÃO selecione o candidato).
4. Se nenhum candidato for uma correspondência confiável ou se houver dúvida razoável, prefira declarar matched como false em vez de tentar escolher o candidato menos ruim.
5. Se houver apenas 1 candidato, verifique se ele possui evidências suficientes (por exemplo, nome coerente mais localização ou segmento compatíveis) e NÃO assuma que ele está correto apenas por ser o único.

Retorne estritamente um JSON no seguinte formato:
{
  "matched": true | false,
  "username": "username_selecionado_ou_null",
  "confidence": 92, // confiança de 0 a 100
  "reason": "breve justificativa da escolha ou rejeição"
}`;

    const disambiguateModel = getAiModel();
    const disambiguateParams: Record<string, unknown> = {
      model: disambiguateModel,
      messages: [
        { role: 'system', content: 'Você é um assistente analista de dados especializado em validação de leads no CRM. Seja extremamente rigoroso para evitar falsos positivos.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    };
    const disambiguateReasoningEffort = getReasoningEffort(disambiguateModel);
    if (disambiguateReasoningEffort) disambiguateParams.reasoning_effort = disambiguateReasoningEffort;
    if (isReasoningModel(disambiguateModel)) {
      disambiguateParams.max_completion_tokens = 1024;
    } else {
      disambiguateParams.max_tokens = 1024;
    }

    const response = await openai.chat.completions.create(disambiguateParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

    const rawContent = response.choices[0].message.content;
    if (!rawContent) {
      return { matched: false, username: null, confidence: 0, reason: 'insufficient_evidence' };
    }

    const parsed = JSON.parse(rawContent);
    return {
      matched: !!parsed.matched && parsed.username !== null,
      username: parsed.username || null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reason: parsed.reason || 'insufficient_evidence'
    };
  } catch (error: any) {
    console.error('Error in disambiguateInstagramCandidates:', error);
    return { matched: false, username: null, confidence: 0, reason: 'error_occurred' };
  }
}

