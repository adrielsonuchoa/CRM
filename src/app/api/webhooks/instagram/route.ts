import type OpenAI from 'openai';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db';
import { activities, leads, settings, webhookEvents } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { sendInstagramMessageViaApi } from '@/lib/meta-api';
import { getOpenAIClient, getAiModel, isAiConfigured } from '@/lib/ai-client';
import { getReasoningEffort, isReasoningModel } from '@/lib/approach-message';

// Este arquivo usava sua PRÓPRIA cópia da configuração da IA (apontando
// direto para o Gemini com GEMINI_API_KEY), separada da usada em ai.ts. Isso
// fez com que, ao migrar para o OpenRouter, a resposta automática sugerida
// aqui continuasse quebrada mesmo depois da troca — corrigido usando o
// mesmo cliente compartilhado (@/lib/ai-client).
function getOpenAI() {
  if (!isAiConfigured()) return null;
  return getOpenAIClient();
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');
  const expectedVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();

  if (mode === 'subscribe' && token && expectedVerifyToken && token === expectedVerifyToken) {
    console.log('[META] Webhook verificado');
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: 'Token de verificacao invalido.' }, { status: 403 });
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const appSecret = process.env.META_APP_SECRET?.trim();

    if (appSecret) {
      const signature = req.headers.get('x-hub-signature-256');
      const expectedSignature = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
      if (!signature || !safeEqual(signature, expectedSignature)) {
        return NextResponse.json({ error: 'Assinatura invalida' }, { status: 401 });
      }
    }

    const payload = JSON.parse(rawBody);
    console.log('[META] Evento recebido');

    if (payload.object === 'instagram' || payload.object === 'page') {
      for (const entry of payload.entry || []) {
        const messagingEvents = entry.messaging || entry.changes || [];
        for (const event of messagingEvents) {
          const senderId = event.sender?.id || event.value?.from?.id;
          const senderUsername = event.sender?.username || event.value?.from?.username;
          const messageText = event.message?.text || event.value?.message;
          const eventId =
            event.message?.mid ||
            event.value?.message_id ||
            event.value?.id ||
            `${entry.id ?? 'entry'}:${senderId ?? senderUsername}:${crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex')}`;

          if (messageText && (senderId || senderUsername)) {
            await handleInboundMessage(senderId, senderUsername, messageText, eventId);
          }
        }
      }
    }

    return NextResponse.json({ status: 'EVENT_RECEIVED' }, { status: 200 });
  } catch (error: any) {
    console.error('[ERROR] Erro no processamento do webhook Meta:', error?.message ?? error);
    return NextResponse.json({ error: 'Falha ao processar webhook.' }, { status: 500 });
  }
}

async function rememberWebhookEvent(eventId: string, payloadHash: string, leadId?: string) {
  await db.insert(webhookEvents).values({
    id: crypto.randomUUID(),
    provider: 'META',
    eventId,
    leadId,
    payloadHash,
    processedAt: new Date(),
  });
}

async function handleInboundMessage(senderId: string, senderUsername: string | undefined, messageText: string, eventId: string) {
  const payloadHash = crypto.createHash('sha256').update(`${eventId}:${senderId}:${senderUsername}:${messageText}`).digest('hex');
  const duplicate = await db.select({ id: webhookEvents.id }).from(webhookEvents).where(eq(webhookEvents.eventId, eventId)).limit(1);
  if (duplicate.length > 0) {
    console.log('[META] Evento duplicado ignorado');
    return;
  }

  let existingLead = null;

  if (senderId) {
    const byPsid = await db.select().from(leads).where(eq(leads.metaPsid, senderId)).limit(1);
    if (byPsid.length > 0) existingLead = byPsid[0];
  }

  if (!existingLead && senderUsername) {
    const cleanIg = senderUsername.replace(/^@/, '').trim();
    const byIg = await db.select().from(leads).where(eq(leads.instagramUsername, cleanIg)).limit(1);
    if (byIg.length > 0) existingLead = byIg[0];
  }

  if (!existingLead) {
    console.log('[META] Lead nao localizado para mensagem recebida');
    await rememberWebhookEvent(eventId, payloadHash);
    return;
  }

  const leadId = existingLead.id;
  const now = new Date();

  await db.update(leads).set({
    metaPsid: senderId || existingLead.metaPsid,
    conversationProvider: 'META_API',
    pipelineStage: existingLead.pipelineStage === 'CONTATO REALIZADO' ? 'RESPONDEU' : existingLead.pipelineStage,
    lastContactAt: now,
    updatedAt: now,
  }).where(eq(leads.id, leadId));

  await db.insert(activities).values({
    id: crypto.randomUUID(),
    leadId,
    type: 'MESSAGE_RECEIVED',
    channel: 'INSTAGRAM',
    direction: 'INBOUND',
    content: messageText,
    metadata: JSON.stringify({ senderId, senderUsername, provider: 'META_API', eventId }),
    createdAt: now,
  });
  console.log('[META] Mensagem recebida');

  let suggestedReply = '';
  const openai = getOpenAI();
  if (openai) {
    try {
      const replyModel = getAiModel();
      const replyParams: Record<string, unknown> = {
        model: replyModel,
        messages: [
          {
            role: 'system',
            content: 'Voce escreve respostas comerciais curtas para a Sirrus. Use apenas a mensagem recebida e dados do lead; nao invente informacoes.',
          },
          {
            role: 'user',
            content: `Lead: ${existingLead.businessName}\nMensagem recebida: ${messageText}\nGere uma resposta sugerida curta, cordial e revisavel pelo usuario antes do envio.`,
          },
        ],
      };
      // Mesmo cuidado do ai.ts: modelos "reasoning" gastam parte do
      // orcamento de tokens de saida pensando internamente antes de
      // escrever a resposta. Sem isso, a resposta sugerida pode sair
      // cortada no meio da frase.
      const replyReasoningEffort = getReasoningEffort(replyModel);
      if (replyReasoningEffort) replyParams.reasoning_effort = replyReasoningEffort;
      if (isReasoningModel(replyModel)) {
        replyParams.max_completion_tokens = 512;
      } else {
        replyParams.max_tokens = 200;
      }
      const aiRes = await openai.chat.completions.create(replyParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
      suggestedReply = aiRes.choices[0]?.message?.content || '';
    } catch (err: any) {
      console.error('[ERROR] Erro ao gerar resposta sugerida:', err?.message ?? err);
    }
  }

  if (suggestedReply) {
    await db.insert(activities).values({
      id: crypto.randomUUID(),
      leadId,
      type: 'MESSAGE_GENERATED',
      channel: 'INSTAGRAM',
      direction: 'OUTBOUND',
      content: suggestedReply,
      metadata: JSON.stringify({ provider: 'META_API', suggestedReply: true, autoSent: false, eventId }),
      createdAt: new Date(),
    });
  }

  const config = (await db.select().from(settings).limit(1))[0];
  const autoReply = (config?.autoReplyEnabled ?? false) && process.env.AUTO_REPLY === 'true';
  if (autoReply && !existingLead.doNotContact && senderId && suggestedReply) {
    const sendRes = await sendInstagramMessageViaApi(senderId, suggestedReply);
    if (sendRes.success) {
      await db.insert(activities).values({
        id: crypto.randomUUID(),
        leadId,
        type: 'MESSAGE_SENT',
        channel: 'INSTAGRAM',
        direction: 'OUTBOUND',
        content: suggestedReply,
        metadata: JSON.stringify({ provider: 'META_API', autoReply: true, eventId }),
        createdAt: new Date(),
      });
    }
  }

  await rememberWebhookEvent(eventId, payloadHash, leadId);
}
