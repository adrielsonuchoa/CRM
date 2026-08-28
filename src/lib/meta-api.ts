import { db } from '@/db';
import { leads, activities } from '@/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type MetaApiStatus = {
  configured: boolean;
  tokenStatus: 'VALID' | 'INVALID' | 'NOT_CONFIGURED';
  webhookActive: boolean;
  message?: string;
};

function getEnvVar(key: string): string {
  let val = process.env[key];
  if (!val || !val.trim()) {
    try {
      const envLocalPath = path.join(process.cwd(), '.env.local');
      if (fs.existsSync(envLocalPath)) {
        const content = fs.readFileSync(envLocalPath, 'utf8');
        const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
        if (match && match[1]) {
          val = match[1];
        }
      }
    } catch {}
  }
  if (!val || !val.trim()) {
    try {
      const envPath = path.join(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
        if (match && match[1]) {
          val = match[1];
        }
      }
    } catch {}
  }
  return (val || '').trim().replace(/^["']|["']$/g, '').trim();
}

export function getMetaApiStatusConfig(): {
  configured: boolean;
  webhookActive: boolean;
  hasToken: boolean;
} {
  const token = getEnvVar('META_ACCESS_TOKEN');
  const accountId = getEnvVar('INSTAGRAM_ACCOUNT_ID');
  const verifyToken = getEnvVar('META_WEBHOOK_VERIFY_TOKEN');

  return {
    configured: !!(token && (accountId || token.startsWith('IGAA'))),
    webhookActive: !!verifyToken,
    hasToken: !!token,
  };
}

export async function testMetaConnection(): Promise<{
  success: boolean;
  status: MetaApiStatus['tokenStatus'];
  message: string;
}> {
  const token = getEnvVar('META_ACCESS_TOKEN');
  const accountId = getEnvVar('INSTAGRAM_ACCOUNT_ID');

  if (!token) {
    return {
      success: false,
      status: 'NOT_CONFIGURED',
      message: 'META_ACCESS_TOKEN não configurado no arquivo .env.',
    };
  }

  try {
    // 1. Try Instagram Graph API (for IGAA... tokens or direct IG accounts)
    try {
      const igRes = await fetch(`https://graph.instagram.com/me?fields=id,username&access_token=${token}`);
      const igData = await igRes.json();
      if (igRes.ok && igData.id) {
        return {
          success: true,
          status: 'VALID',
          message: `Conexão válida! Conta Instagram: @${igData.username || igData.id}. (Instagram Direct API)`,
        };
      }
    } catch {}

    // 2. Try Facebook Graph API (for EAA... tokens)
    const fbUrl = accountId 
      ? `https://graph.facebook.com/v19.0/${accountId}?fields=id,name,username&access_token=${token}`
      : `https://graph.facebook.com/v19.0/me?fields=id,name,username&access_token=${token}`;

    const res = await fetch(fbUrl);
    const data = await res.json();

    if (res.ok && data.id) {
      return {
        success: true,
        status: 'VALID',
        message: `Conexão válida! Conta Instagram: @${data.username || data.name || data.id}. (Meta Graph API)`,
      };
    }

    return {
      success: false,
      status: 'INVALID',
      message: `Token ou Account ID inválido: ${data.error?.message || 'Falha de autenticação API'}.`,
    };
  } catch (err: any) {
    return {
      success: false,
      status: 'INVALID',
      message: `Erro ao conectar com Meta/Instagram API: ${err.message}`,
    };
  }
}

export async function sendInstagramMessageViaApi(
  recipientPsid: string,
  text: string
): Promise<{ success: boolean; error?: string }> {
  const token = getEnvVar('META_ACCESS_TOKEN');
  if (!token) {
    return { success: false, error: 'META_ACCESS_TOKEN não configurado.' };
  }

  try {
    if (token.startsWith('IGAA')) {
      const res = await fetch(`https://graph.instagram.com/v19.0/me/messages?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: recipientPsid },
          message: { text },
        }),
      });

      const data = await res.json();
      if (res.ok && (data.message_id || data.id)) {
        return { success: true };
      } else {
        return { success: false, error: data.error?.message || 'Erro ao enviar mensagem via Instagram API.' };
      }
    } else {
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
    }
  } catch (err: any) {
    return { success: false, error: `Erro na requisição para Meta API: ${err.message}` };
  }
}
