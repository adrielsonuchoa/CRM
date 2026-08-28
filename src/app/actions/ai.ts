'use server';

import OpenAI from 'openai';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import { db } from '@/db';
import { leads, activities } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import crypto from 'crypto';

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada. Adicione a chave no arquivo .env para usar funcionalidades de IA.');
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const ScoreSchema = z.object({
  score: z.number().describe('Pontuação de 0 a 100.'),
  qualification: z.enum(['ALTA PRIORIDADE', 'BOA OPORTUNIDADE', 'MÉDIA PRIORIDADE', 'BAIXA PRIORIDADE']),
  reasons: z.array(z.string()).describe('Motivos factuais para a pontuação'),
  possibleNeeds: z.array(z.string()).describe('Necessidades inferidas (PDV, comandas, mesas, estoque, delivery)'),
  confidence: z.number().describe('Confiança de 0.0 a 1.0'),
  summary: z.string().describe('Resumo factual do estabelecimento, separando fatos de inferências'),
});

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
Delivery: ${lead.hasDelivery ? 'Sim' : lead.hasDelivery === false ? 'Não' : 'Desconhecido'}
Salão: ${lead.hasDiningRoom ? 'Sim' : lead.hasDiningRoom === false ? 'Não' : 'Desconhecido'}
Garçons: ${lead.hasWaiters ? 'Sim' : lead.hasWaiters === false ? 'Não' : 'Desconhecido'}
Múltiplas Unidades: ${lead.hasMultipleUnits ? 'Sim' : 'Não'}
Notas: ${lead.notes ?? 'Sem notas.'}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é um especialista em vendas da Sirrus, sistemas de gestão para food service. Nunca invente dados não fornecidos. Responda em JSON válido correspondente ao schema do lead.' },
        { role: 'user', content: prompt + '\n\nRetorne a resposta estritamente no formato JSON com as chaves: score (número 0-100), qualification ("ALTA PRIORIDADE" | "BOA OPORTUNIDADE" | "MÉDIA PRIORIDADE" | "BAIXA PRIORIDADE"), reasons (array de strings), possibleNeeds (array de strings: PDV, comandas, mesas, estoque, delivery), confidence (número 0.0-1.0), summary (string).' },
      ],
      response_format: { type: 'json_object' },
    });

    const rawContent = response.choices[0].message.content;
    if (!rawContent) throw new Error('Falha ao obter resposta da IA.');
    const result = ScoreSchema.parse(JSON.parse(rawContent));

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

    revalidatePath('/prospecting');
    revalidatePath(`/leads/${leadId}`);
    revalidatePath('/');
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
      model: 'gpt-4o-mini',
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

    revalidatePath(`/leads/${leadId}`);
    return { success: true, message };
  } catch (error: any) {
    console.error('Error generating message:', error);
    return { success: false, error: error.message };
  }
}
