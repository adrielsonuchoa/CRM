import { chromium, BrowserContext, Page } from 'playwright';
import { db } from '@/db';
import { leads, activities } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { analyzeLeadAction, generateMessageAction } from '@/app/actions/ai';

export type WorkerStatus = {
  status: 'IDLE' | 'RUNNING' | 'PAUSED' | 'ERROR' | 'DISCONNECTED';
  chromeConnected: boolean;
  instagramProfile: string | null;
  automationsActive: boolean;
  dailyLimit: number;
  sentToday: number;
  queueSize: number;
  lastError: string | null;
};

// In-memory worker state
let workerState: {
  status: 'IDLE' | 'RUNNING' | 'PAUSED' | 'ERROR' | 'DISCONNECTED';
  lastError: string | null;
  isPausedManual: boolean;
} = {
  status: 'IDLE',
  lastError: null,
  isPausedManual: false,
};

let sentTodayCount = 0;
let lastResetDate = new Date().toDateString();

function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    sentTodayCount = 0;
    lastResetDate = today;
  }
}

export function getDailyLimit(): number {
  const envVal = process.env.MAX_FIRST_DMS_PER_DAY;
  return envVal ? parseInt(envVal, 10) || 5 : 5;
}

export async function checkChromeConnection(): Promise<{
  connected: boolean;
  username: string | null;
  error?: string;
}> {
  const cdpUrl = process.env.CHROME_CDP_URL || 'http://localhost:9222';
  try {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const contexts = browser.contexts();
    const username = process.env.INSTAGRAM_USERNAME || 'Autenticado';
    await browser.close();
    return { connected: true, username };
  } catch (err: any) {
    return {
      connected: false,
      username: null,
      error: `Não foi possível conectar ao Chrome no CDP (${cdpUrl}): ${err.message || 'Porta fechada ou Chrome indisponível'}.`,
    };
  }
}

export async function getWorkerStatus(): Promise<WorkerStatus> {
  checkDailyReset();
  const cdpCheck = await checkChromeConnection();
  const dailyLimit = getDailyLimit();

  const queueResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(leads)
    .where(
      sql`${leads.pipelineStage} IN ('QUALIFICADO', 'PRONTO PARA CONTATO') AND ${leads.doNotContact} = 0 AND ${leads.instagramUsername} IS NOT NULL`
    );

  const queueSize = Number(queueResult[0]?.count ?? 0);

  let currentStatus: WorkerStatus['status'] = workerState.status;
  if (!cdpCheck.connected) {
    currentStatus = 'DISCONNECTED';
  } else if (workerState.isPausedManual) {
    currentStatus = 'PAUSED';
  }

  return {
    status: currentStatus,
    chromeConnected: cdpCheck.connected,
    instagramProfile: cdpCheck.username,
    automationsActive: process.env.AUTO_FIRST_CONTACT !== 'false' && !workerState.isPausedManual && cdpCheck.connected,
    dailyLimit,
    sentToday: sentTodayCount,
    queueSize,
    lastError: workerState.lastError,
  };
}

export function pauseWorker() {
  workerState.isPausedManual = true;
  workerState.status = 'PAUSED';
  return { success: true, message: 'Automação pausada.' };
}

export function startWorker() {
  workerState.isPausedManual = false;
  workerState.status = 'IDLE';
  workerState.lastError = null;
  return { success: true, message: 'Automação iniciada.' };
}

export async function sendFirstDmViaBrowser(leadId: string): Promise<{ success: boolean; error?: string }> {
  checkDailyReset();
  const dailyLimit = getDailyLimit();

  if (workerState.isPausedManual) {
    return { success: false, error: 'Automação está pausada manualmente.' };
  }

  if (sentTodayCount >= dailyLimit) {
    return { success: false, error: `Limite diário de envio (${dailyLimit} DMs) atingido para hoje.` };
  }

  const leadRecord = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  const lead = leadRecord[0];

  if (!lead) return { success: false, error: 'Lead não encontrado.' };
  if (lead.doNotContact) return { success: false, error: 'Lead marcado como NÃO CONTATAR.' };
  if (!lead.instagramUsername) return { success: false, error: 'Lead não possui usuário de Instagram.' };

  // Fetch or generate message
  let messageToSend = '';
  const lastGenerated = await db
    .select()
    .from(activities)
    .where(sql`${activities.leadId} = ${leadId} AND ${activities.type} = 'MESSAGE_GENERATED'`)
    .limit(1);

  if (lastGenerated.length > 0 && lastGenerated[0].content) {
    messageToSend = lastGenerated[0].content;
  } else {
    const genResult = await generateMessageAction(leadId);
    if (!genResult.success || !genResult.message) {
      return { success: false, error: `Falha ao gerar mensagem via IA: ${genResult.error}` };
    }
    messageToSend = genResult.message;
  }

  const cdpUrl = process.env.CHROME_CDP_URL || 'http://localhost:9222';
  let browser;

  try {
    workerState.status = 'RUNNING';
    browser = await chromium.connectOverCDP(cdpUrl);
    const contexts = browser.contexts();
    const context = contexts[0] || (await browser.newContext());
    const page = await context.newPage();

    const cleanUsername = lead.instagramUsername.replace(/^@/, '').trim();
    const profileUrl = `https://www.instagram.com/${cleanUsername}/`;

    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Safety checks: challenges, log in required, suspensions
    const pageContent = await page.content();
    if (
      pageContent.includes('Help Us Verify It\'s You') ||
      pageContent.includes('Suspended') ||
      pageContent.includes('Entrar no Instagram') ||
      pageContent.includes('Log In to Instagram') ||
      pageContent.includes('Sua conta foi temporariamente bloqueada')
    ) {
      workerState.status = 'PAUSED';
      workerState.isPausedManual = true;
      workerState.lastError = `Instagram solicitou verificação/login em ${cleanUsername}. Automação pausada por segurança.`;
      await page.close();
      await browser.close();
      return { success: false, error: workerState.lastError };
    }

    // Try finding "Enviar mensagem" or "Message" button
    const messageButtonSelectors = [
      'button:has-text("Enviar mensagem")',
      'button:has-text("Message")',
      'div[role="button"]:has-text("Enviar mensagem")',
      'div[role="button"]:has-text("Message")',
      'a:has-text("Enviar mensagem")',
      'a:has-text("Message")',
    ];

    let clicked = false;
    for (const selector of messageButtonSelectors) {
      const btn = page.locator(selector).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // Direct navigation fallback to direct messages if button not found directly
      await page.goto(`https://www.instagram.com/direct/new/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const searchInput = page.locator('input[name="queryBox"], input[placeholder*="Pesquisar"], input[placeholder*="Search"]').first();
      if ((await searchInput.count()) > 0) {
        await searchInput.fill(cleanUsername);
        await page.waitForTimeout(2000);
        const userResult = page.locator(`span:has-text("${cleanUsername}")`).first();
        if ((await userResult.count()) > 0) {
          await userResult.click();
          await page.waitForTimeout(1000);
          const nextBtn = page.locator('button:has-text("Chat"), button:has-text("Avançar"), div[role="button"]:has-text("Avançar")').first();
          if ((await nextBtn.count()) > 0) await nextBtn.click();
          clicked = true;
        }
      }
    }

    if (!clicked) {
      await page.close();
      await browser.close();
      workerState.status = 'ERROR';
      workerState.lastError = `Não foi possível localizar o botão de mensagem no perfil @${cleanUsername}.`;
      return { success: false, error: workerState.lastError };
    }

    await page.waitForTimeout(3000);

    // Locate DM input box
    const chatInput = page.locator('div[contenteditable="true"], textarea[placeholder*="Mensagem"], textarea[placeholder*="Message"]').first();
    if ((await chatInput.count()) === 0) {
      await page.close();
      await browser.close();
      workerState.status = 'ERROR';
      workerState.lastError = `Campo de digitação do chat não encontrado para @${cleanUsername}.`;
      return { success: false, error: workerState.lastError };
    }

    await chatInput.focus();
    await chatInput.fill(messageToSend);
    await page.waitForTimeout(1000);
    await chatInput.press('Enter');
    await page.waitForTimeout(3000);

    await page.close();
    await browser.close();

    // Success in DB
    const now = new Date();
    await db
      .update(leads)
      .set({
        pipelineStage: 'CONTATO REALIZADO',
        conversationProvider: 'BROWSER',
        firstContactAt: lead.firstContactAt ?? now,
        lastContactAt: now,
        updatedAt: now,
      })
      .where(eq(leads.id, leadId));

    await db.insert(activities).values({
      id: crypto.randomUUID(),
      leadId,
      type: 'MESSAGE_SENT',
      channel: 'INSTAGRAM',
      direction: 'OUTBOUND',
      content: messageToSend,
      metadata: JSON.stringify({ provider: 'BROWSER', via: 'PLAYWRIGHT_CDP' }),
      createdAt: now,
    });

    sentTodayCount++;
    workerState.status = 'IDLE';
    workerState.lastError = null;

    return { success: true };
  } catch (err: any) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    workerState.status = 'ERROR';
    workerState.lastError = `Erro durante execução do Playwright: ${err.message}`;
    return { success: false, error: workerState.lastError };
  }
}
