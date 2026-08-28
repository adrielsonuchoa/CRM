import { db } from '@/db';
import { leads, activities } from '@/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

export type MetaApiStatus = {
  configured: boolean;
  tokenStatus: 'VALID' | 'INVALID' | 'NOT_CONFIGURED';
  webhookActive: boolean;
  message?: string;
};

export function getMetaApiStatusConfig(): {
  configured: boolean;
  webhookActive: boolean;
  hasToken: boolean;
} {
  const token = process.env.META_ACCESS_TOKEN?.trim();
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID?.trim();
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();

  return {
    configured: !!(token && accountId),
    webhookActive: !!verifyToken,
    hasToken: !!token,
  };
}

export async function testMetaConnection(): Promise<{
  success: boolean;
  status: MetaApiStatus['tokenStatus'];
  message: string;
}> {
  const token = process.env.META_ACCESS_TOKEN?.trim();
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID?.trim();

  if (!token || !accountId) {
    return {
      success: false,
      status: 'NOT_CONFIGURED',
      message: 'META_ACCESS_TOKEN ou INSTAGRAM_ACCOUNT_ID não configurados no arquivo .env.',
    };
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${accountId}?fields=id,name,username&access_token=${token}`);
    const data = await res.json();

    if (res.ok && data.id) {
      return {
        success: true,
        status: 'VALID',
        message: `Conexão válida! Conta Instagram: @${data.username || data.name || data.id}.`,
      };
    } else {
      return {
        success: false,
        status: 'INVALID',
        message: `Token ou Account ID inválido: ${data.error?.message || 'Falha de autenticação Graph API'}.`,
      };
    }
  } catch (err: any) {
    return {
      success: false,
      status: 'INVALID',
      message: `Erro ao conectar com Meta Graph API: ${err.message}`,
    };
  }
}

export async function sendInstagramMessageViaApi(
  recipientPsid: string,
  text: string
): Promise<{ success: boolean; error?: string }> {
  const token = process.env.META_ACCESS_TOKEN?.trim();
  if (!token) {
    return { success: false, error: 'META_ACCESS_TOKEN não configurado.' };
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientPsid },
        message: { text },
      }),
    });

    const data = await res.json();
    if (res.ok && data.message_id) {
      return { success: true };
    } else {
      return { success: false, error: data.error?.message || 'Erro ao enviar mensagem via Meta API.' };
    }
  } catch (err: any) {
    return { success: false, error: `Erro na requisição para Meta API: ${err.message}` };
  }
}
