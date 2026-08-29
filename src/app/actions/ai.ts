'use server';

import OpenAI from 'openai';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import { db } from '@/db';
import { activities, leads, settings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY não configurada. Adicione a chave no arquivo .env para usar funcionalidades de IA.');
  }
  return new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || (apiKey.startsWith('gsk_') ? 'https://api.groq.com/openai/v1' : undefined),
  });
}

function getAiModel() {
  return process.env.OPENAI_MODEL || (process.env.OPENAI_API_KEY?.trim().startsWith('gsk_') ? 'openai/gpt-oss-20b' : 'gpt-4o-mini');
}

const ScoreSchema = z.object({
  score: z.number().describe('Pontuação de 0 a 100.'),
  qualification: z.enum(['ALTA PRIORIDADE', 'BOA OPORTUNIDADE', 'MÉDIA PRIORIDADE', 'BAIXA PRIORIDADE']),
  reasons: z.array(z.string()).describe('Motivos factuais para a pontuação'),
  possibleNeeds: z.array(z.string()).describe('Necessidades inferidas (PDV, comandas, mesas, estoque, delivery)'),
  confidence: z.number().describe('Confiança de 0.0 a 1.0'),
  summary: z.string().describe('Resumo factual do estabelecimento, separando fatos de inferências'),
});

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

export async function analyzeLeadAction(leadId: string) {
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

    const response = await openai.chat.completions.create({
      model: getAiModel(),
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: 'Você é um especialista em vendas da Sirrus, sistemas de gestão para food service. Nunca invente dados não fornecidos. Responda em JSON válido correspondente ao schema do lead.' },
        { role: 'user', content: prompt + '\n\nRetorne a resposta estritamente no formato JSON com as chaves: score (número 0-100), qualification ("ALTA PRIORIDADE" | "BOA OPORTUNIDADE" | "MÉDIA PRIORIDADE" | "BAIXA PRIORIDADE"), reasons (array de strings), possibleNeeds (array de strings: PDV, comandas, mesas, estoque, delivery), confidence (número 0.0-1.0), summary (string).' },
      ],
      response_format: { type: 'json_object' },
    });

    const rawContent = response.choices[0].message.content;
    if (!rawContent) throw new Error('Falha ao obter resposta da IA.');

    let parsed: unknown;
    try {
      parsed = extractJsonObject(rawContent);
    } catch {
      const fallback = rawContent.match(/\{[\s\S]*\}/)?.[0];
      if (!fallback) throw new Error('Resposta da IA não está em JSON válido.');
      parsed = extractJsonObject(fallback);
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
    return { success: false, error: error.message };
  }
}

export async function generateMessageAction(leadId: string, strategy: string = 'Consultiva') {
  try {
    const openai = getOpenAI();
    const leadRecord = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    const lead = leadRecord[0];
    if (!lead) throw new Error('Lead não encontrado.');

    const strategyGuides: Record<string, string> = {
      Consultiva: 'Pergunte sobre o sistema atual sem citar o da Sirrus. Ex: "Hoje vocês usam algum sistema para comandas, caixa e gestão?"',
      Local: 'Destaque que você é representante em Maceió e pesquisou a região. Ex: "Encontrei o perfil de vocês pesquisando operações da região."',
      Problema: 'Faça uma pergunta sobre uma dor operacional comum. Ex: "Vocês trabalham com salão e delivery juntos? Pergunto porque tenho trabalhado com restaurantes que buscam centralizar essas operações."',
      Direta: 'Apresente-se diretamente como representante da Sirrus e pergunte se estão satisfeitos com o sistema atual.',
    };

    const guide = strategyGuides[strategy] || strategyGuides['Consultiva'];

    const prompt = `Você é um representante comercial da Sirrus em Maceió/AL. Escreva uma PRIMEIRA MENSAGEM de prospecção para Instagram ou WhatsApp.

Estabelecimento: ${lead.businessName}
Categoria: ${lead.category ?? 'Restaurante/Bar'}
Bairro: ${lead.neighborhood ?? 'Maceió'}
Características: ${[
      lead.hasDelivery ? 'faz delivery' : null,
      lead.hasDiningRoom ? 'tem salão' : null,
      lead.hasWaiters ? 'tem garçons' : null,
      lead.followers ? `${lead.followers} seguidores no Instagram` : null,
    ].filter(Boolean).join(', ') || 'não informadas'}
Presença digital: Instagram ativo = ${lead.instagramActive == null ? 'desconhecido' : lead.instagramActive ? 'sim' : 'não'}; website = ${lead.website ?? 'não informado'}
Reputação: avaliação ${lead.rating ?? 'não informada'} com ${lead.reviewCount ?? 'número de'} avaliações
Operação: sistema atual = ${lead.currentSystem ?? 'não informado'}; porte estimado = ${lead.estimatedSize ?? 'não informado'}; complexidade = ${lead.estimatedOperationComplexity ?? 'não informada'}
Localização: ${lead.address ?? 'endereço não informado'}, ${lead.neighborhood ?? lead.city ?? 'região não informada'}
Necessidades e observações já registradas: ${lead.painPoints ?? 'nenhuma'}; ${lead.notes ?? 'nenhuma'}

Estratégia: ${strategy}
Como aplicar: ${guide}

REGRAS OBRIGATÓRIAS:
1. Seja breve (máximo 4 frases).
2. Comece com cumprimento informal, sem "Prezado" ou "Caro".
3. Faça uma observação verdadeira sobre o estabelecimento usando APENAS as informações acima.
4. Apresente-se como representante da Sirrus em Maceió.
5. Termine com UMA pergunta simples e aberta.
6. NÃO prometa nada, NÃO cite preços, NÃO force uma venda.
7. NÃO invente informações sobre o estabelecimento.
8. Use no máximo 1 emoji.
9. Escreva em português informal mas profissional.`;

    const response = await openai.chat.completions.create({
      model: getAiModel(),
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: 'Você é um representante comercial local que escreve mensagens naturais, diretas e não corporativas.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 300,
      temperature: 0.7,
    });

    const message = response.choices[0].message.content;
    if (!message) throw new Error('Mensagem vazia gerada pela IA.');

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

    const response = await openai.chat.completions.create({
      model: getAiModel(),
      messages: [
        { role: 'system', content: 'Você é um assistente analista de dados especializado em validação de leads no CRM. Seja extremamente rigoroso para evitar falsos positivos.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    });

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

