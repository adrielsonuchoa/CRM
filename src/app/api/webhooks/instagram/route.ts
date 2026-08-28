import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db';
import { leads, activities } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { sendInstagramMessageViaApi } from '@/lib/meta-api';
import OpenAI from 'openai';

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// GET: Verification endpoint for Meta Webhook
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const expectedVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();

  if (mode === 'subscribe' && token && expectedVerifyToken && token === expectedVerifyToken) {
    console.log('Webhook Meta verificado com sucesso.');
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: 'Token de verificação inválido.' }, { status: 403 });
}

// POST: Message receiver webhook
export async function POST(req: NextRequest) {
  try {
    const appSecret = process.env.META_APP_SECRET?.trim();
    const rawBody = await req.text();

    // Verify signature if app secret is provided
    if (appSecret) {
      const signature = req.headers.get('x-hub-signature-256');
      if (signature) {
        const expectedSignature = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
        if (signature !== expectedSignature) {
          return NextResponse.json({ error: 'Assinatura inválida' }, { status: 401 });
        }
      }
    }

    const payload = JSON.parse(rawBody);

    if (payload.object === 'instagram' || payload.object === 'page') {
      for (const entry of payload.entry || []) {
        const messagingEvents = entry.messaging || entry.changes || [];
        for (const event of messagingEvents) {
          const senderId = event.sender?.id || event.value?.from?.id;
          const senderUsername = event.sender?.username || event.value?.from?.username;
          const messageText = event.message?.text || event.value?.message;

          if (messageText && (senderId || senderUsername)) {
            await handleInboundMessage(senderId, senderUsername, messageText);
          }
        }
      }
    }

    return NextResponse.json({ status: 'EVENT_RECEIVED' }, { status: 200 });
  } catch (error: any) {
    console.error('Erro no processamento do webhook Meta:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function handleInboundMessage(senderId: string, senderUsername: string | undefined, messageText: string) {
  // Find lead by metaPsid or instagramUsername
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
    console.log(`Lead não localizado no banco para mensagem recebida de ID=${senderId}, Username=${senderUsername}`);
    return;
  }

  const leadId = existingLead.id;
  const now = new Date();

  // 1. Update lead: set conversationProvider to META_API, update metaPsid and pipeline stage
  await db
    .update(leads)
    .set({
      metaPsid: senderId || existingLead.metaPsid,
      conversationProvider: 'META_API',
      pipelineStage: existingLead.pipelineStage === 'CONTATO REALIZADO' ? 'RESPONDEU' : existingLead.pipelineStage,
      lastContactAt: now,
      updatedAt: now,
    })
    .where(eq(leads.id, leadId));

  // 2. Record MESSAGE_RECEIVED activity
  await db.insert(activities).values({
    id: crypto.randomUUID(),
    leadId,
    type: 'MESSAGE_RECEIVED',
    channel: 'INSTAGRAM',
    direction: 'INBOUND',
    content: messageText,
    metadata: JSON.stringify({ senderId, senderUsername, provider: 'META_API' }),
    createdAt: now,
  });

  // 3. Classify intention & suggest reply using OpenAI
  const openai = getOpenAI();
  let suggestedReply = '';

  if (openai) {
    try {
      const prompt = `O lead "${existingLead.businessName}" respondeu à prospecção com a mensagem: "${messageText}".
Você é um especialista comercial da Sirrus em Maceió.
Gere uma resposta curta (2-3 frases), cordial, tirando dúvidas e convidando para uma demonstração do sistema para restaurante.`;

      const aiRes = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
      });

      suggestedReply = aiRes.choices[0].message.content || '';
    } catch (err) {
      console.error('Erro ao gerar resposta com IA:', err);
    }
  }

  // 4. Auto Reply if AUTO_REPLY=true and not DO_NOT_CONTACT
  const autoReply = process.env.AUTO_REPLY === 'true';
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
        metadata: JSON.stringify({ provider: 'META_API', autoReply: true }),
        createdAt: new Date(),
      });
    }
  }
}
