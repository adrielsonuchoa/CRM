import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { db } from '@/db';
import { activities, dailyActionCounters, leads, settings, workerState } from '@/db/schema';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { analyzeLeadAction, generateMessageAction } from '@/app/actions/ai';
import { discoverGeoapifyPlaces } from '@/lib/prospecting-sources';
import { enrichLeadWithInstagram, searchInstagramUsernames } from '@/lib/instagram-enrichment';
import { isAiConfigured } from '@/lib/ai-client';

export type WorkerStatus = {
  status: 'ATIVO' | 'PAUSADO' | 'PROCESSANDO' | 'AGUARDANDO' | 'ERRO' | 'DESCONECTADO';
  chromeConnected: boolean;
  instagramProfile: string | null;
  automationsActive: boolean;
  dailyLimit: number;
  sentToday: number;
  queueSize: number;
  activity: string | null;
  dryRun: boolean;
  lastError: string | null;
  currentLeadName: string | null;
  previewScreenshot: string | null;
};

export type WorkerLogEntry = {
  id: string;
  type: string;
  channel: string | null;
  content: string | null;
  leadName: string | null;
  createdAt: Date;
};

const WORKER_ID = 'browser-worker';
const DAILY_DM_ACTION = 'FIRST_DM';
let activeWorkerRun: Promise<{ success: boolean; error?: string; message?: string }> | null = null;
let cdpBrowser: any = null;
let cdpConnectionPromise: Promise<any> | null = null;
let currentWorkerLeadName: string | null = null;
let workerPreviewScreenshot: string | null = null;
const preparedDmPages = new Map<string, { page: Page; browser: Browser }>();

async function createBackgroundInstagramPage() {
  const sessionBrowser = await getBrowserConnection();
  const sessionContext = await ensureBrowserContext(sessionBrowser);
  const storageState = await sessionContext.storageState();
  const { executablePath } = getChromeLaunchConfig();
  const backgroundBrowser = await chromium.launch(executablePath
    ? { headless: true, executablePath }
    : { headless: true, channel: 'chrome' });
  const context = await backgroundBrowser.newContext({
    storageState,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  return { browser: backgroundBrowser, context, page };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getChromeLaunchConfig() {
  const userDataDir = (process.env.CHROME_USER_DATA_DIR || path.join(process.cwd(), '.tmp-chrome-profile')).trim();
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  const executablePath = process.env.CHROME_EXECUTABLE_PATH?.trim() || undefined;
  return {
    userDataDir,
    executablePath,
  };
}

async function ensureBrowserContext(browser: Browser | BrowserContext): Promise<BrowserContext> {
  if ('contexts' in browser && typeof browser.contexts === 'function') {
    const contexts = browser.contexts();
    if (contexts.length > 0) return contexts[0];
    return await browser.newContext();
  }
  return browser as BrowserContext;
}

async function getBrowserPages(browser: Browser | BrowserContext) {
  if ('contexts' in browser && typeof browser.contexts === 'function') {
    return browser.contexts().flatMap((context: any) => context.pages());
  }
  return (browser as BrowserContext).pages();
}

async function getBrowserConnection() {
  if (cdpBrowser?.isConnected?.()) return cdpBrowser;

  const preferredCdpUrl = process.env.CHROME_CDP_URL?.trim() || 'http://localhost:9222';

  if (!cdpConnectionPromise) {
    cdpConnectionPromise = chromium.connectOverCDP(preferredCdpUrl)
      .then((browser) => {
        cdpBrowser = browser;
        return browser;
      })
      .catch(async () => {
        if (preferredCdpUrl !== 'http://localhost:9222') throw new Error(`CDP unavailable at ${preferredCdpUrl}`);

        const { userDataDir, executablePath } = getChromeLaunchConfig();
        if (executablePath) {
          const browserContext = await chromium.launchPersistentContext(userDataDir, {
            headless: true,
            executablePath,
          });
          cdpBrowser = browserContext as any;
          return browserContext;
        }

        throw new Error('Nenhum Chrome real encontrado na porta 9222 nem em um executável configurado.');
      })
      .finally(() => {
        cdpConnectionPromise = null;
      });
  }

  return cdpConnectionPromise;
}

function releaseBrowserConnection(_browser: Browser | undefined) {
  void _browser;
  // A CDP browser belongs to the user. Closing it would close Chrome and its tabs.
}

function parseJsonList(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  }
}

async function getSettings() {
  const row = (await db.select().from(settings).limit(1))[0];
  return row ?? null;
}

async function ensureWorkerState() {
  const now = new Date();
  const existing = (await db.select().from(workerState).where(eq(workerState.id, WORKER_ID)).limit(1))[0];
  if (existing) return existing;

  await db.insert(workerState).values({
    id: WORKER_ID,
    status: 'PAUSADO',
    activity: 'Aguardando inicio manual',
    chromeConnected: false,
    dryRun: true,
    updatedAt: now,
  });

  return (await db.select().from(workerState).where(eq(workerState.id, WORKER_ID)).limit(1))[0];
}

async function setWorkerState(patch: Partial<typeof workerState.$inferInsert>) {
  await ensureWorkerState();
  await db.update(workerState).set({ ...patch, updatedAt: new Date() }).where(eq(workerState.id, WORKER_ID));
}

export async function getDailyLimit(): Promise<number> {
  const s = await getSettings();
  const envVal = process.env.MAX_FIRST_DMS_PER_DAY;
  return s?.maxApprovedLeadsPerDay ?? (envVal ? parseInt(envVal, 10) || 5 : 5);
}

async function getCounter(action = DAILY_DM_ACTION) {
  const day = todayKey();
  const limit = await getDailyLimit();
  const existing = (await db
    .select()
    .from(dailyActionCounters)
    .where(and(eq(dailyActionCounters.day, day), eq(dailyActionCounters.action, action)))
    .limit(1))[0];

  if (existing) {
    if (existing.limit !== limit) {
      await db.update(dailyActionCounters).set({ limit, updatedAt: new Date() }).where(eq(dailyActionCounters.id, existing.id));
      return { ...existing, limit };
    }
    return existing;
  }

  const row = {
    id: crypto.randomUUID(),
    day,
    action,
    count: 0,
    limit,
    updatedAt: new Date(),
  };
  await db.insert(dailyActionCounters).values(row);
  return row;
}

async function incrementCounter(action = DAILY_DM_ACTION) {
  const counter = await getCounter(action);
  await db
    .update(dailyActionCounters)
    .set({ count: counter.count + 1, updatedAt: new Date() })
    .where(eq(dailyActionCounters.id, counter.id));
}

export async function checkChromeConnection(): Promise<{
  connected: boolean;
  username: string | null;
  error?: string;
}> {
  const cdpUrl = process.env.CHROME_CDP_URL || 'http://localhost:9222';

  // A Vercel Function nao tem um Chrome persistente nem CDP local. Nao
  // tente abrir um navegador nesse ambiente: o worker de browser deve rodar
  // no processo local/servidor dedicado, enquanto a aplicacao web continua
  // podendo consultar o dashboard normalmente.
  if (process.env.VERCEL === '1') {
    return {
      connected: false,
      username: null,
      error: 'Browser worker executa fora da Vercel; Chrome CDP indisponivel neste ambiente.',
    };
  }

  if (!process.env.CHROME_CDP_URL && !process.env.CHROME_USER_DATA_DIR) {
    // Do not fail early when no env var is set. The user may be running Chrome
    // with the default local CDP port already active, which is the intended flow
    // for Instagram/browser automation.
  }

  try {
    const browser = await getBrowserConnection();
    const pages = await getBrowserPages(browser);
    const instagramPage = pages.find((page: any) => !page.isClosed() && page.url().includes('instagram.com'));
    const context = instagramPage?.context() ?? await ensureBrowserContext(browser);

    const pageText = instagramPage
      ? await instagramPage.locator('body').innerText({ timeout: 3000 }).catch(() => '')
      : '';
    const pageUrl = instagramPage?.url?.() ?? null;
    const cookies = await context.cookies('https://www.instagram.com').catch(() => []);
    const hasSessionCookie = cookies.some((cookie: any) => cookie.name === 'sessionid' && cookie.value);
    const usernameFromUrl = getInstagramUsernameFromUrl(pageUrl);
    const isGuardPage = hasInstagramGuardPage(pageText);
    const hasValidInstagramPage = !!instagramPage && !!pageText && !isGuardPage;
    const hasInstagramSession = !!(hasSessionCookie || !!usernameFromUrl || !!process.env.INSTAGRAM_USERNAME);
    const username = hasInstagramSession
      ? (usernameFromUrl || process.env.INSTAGRAM_USERNAME || 'Sessao ativa')
      : null;
    const connected = hasInstagramSession && (!instagramPage || hasValidInstagramPage);
    const error = connected
      ? undefined
      : 'Chrome conectado, mas nenhuma sessao valida do Instagram foi detectada. Abra o Instagram e confirme o login na mesma janela do navegador antes de rodar a busca.';
    releaseBrowserConnection(browser);
    await setWorkerState({ chromeConnected: connected, instagramProfile: username, lastError: error ?? null });
    return { connected, username, error };
  } catch (err: any) {
    const error = process.env.CHROME_CDP_URL?.trim()
      ? `Nao foi possivel conectar ao Chrome CDP (${cdpUrl}). Inicie o Chrome com remote debugging e execute o worker fora da Vercel.`
      : 'Nao foi possivel abrir o Chrome localmente para o Instagram. Verifique o caminho do Chrome ou o perfil configurado.';
    cdpBrowser = null;
    cdpConnectionPromise = null;
    await setWorkerState({ chromeConnected: false, lastError: error, status: 'DESCONECTADO' });
    console.error('[ERROR] Browser desconectado:', err?.message ?? err);
    return { connected: false, username: null, error };
  }
}

export async function testWorkerReadiness() {
  const [cdpCheck, s] = await Promise.all([checkChromeConnection(), getSettings()]);
  const configuredTerms = parseJsonList(s?.prospectingSearchTerms).length > 0 || parseJsonList(s?.prospectingSegments).length > 0;
  const geminiConfigured = isAiConfigured();
  const instagramEnabled = (parseJsonList(s?.prospectingSources).includes('INSTAGRAM') || (s?.prospectingSources ?? '').toUpperCase().includes('INSTAGRAM'));

  return {
    chrome: cdpCheck.connected,
    instagramSession: cdpCheck.connected && !!cdpCheck.username,
    backend: true,
    settings: !!s && configuredTerms,
    openaiConfigured: geminiConfigured,
    message: cdpCheck.connected
      ? 'Worker pronto para pesquisar em modo seguro.'
      : instagramEnabled
        ? 'CDP do Chrome obrigatório para Instagram. Abra o Chrome com --remote-debugging-port=9222 e deixe-o aberto; o sistema não abre o navegador por você.'
        : process.env.CHROME_CDP_URL || process.env.CHROME_USER_DATA_DIR
          ? (cdpCheck.error ?? 'Chrome CDP indisponivel.')
          : 'Busca de empresas em modo seguro sem Chrome CDP.',
  };
}

export async function getWorkerStatus(): Promise<WorkerStatus> {
  const [state, cdpCheck, counter] = await Promise.all([ensureWorkerState(), checkChromeConnection(), getCounter()]);

  const queueResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(leads)
    .where(sql`${leads.pipelineStage} IN ('QUALIFICADO', 'PRONTO PARA CONTATO', 'AGUARDANDO_CONTATO') AND ${leads.doNotContact} = 0 AND ${leads.instagramUsername} IS NOT NULL`);

  const completedRun = state.activity?.startsWith('Execucao concluida:') ?? false;
  const browserConfigured = !!(process.env.CHROME_CDP_URL || process.env.CHROME_USER_DATA_DIR);
  const isRunningWithoutBrowser = !browserConfigured && (state.status === 'ATIVO' || state.status === 'PROCESSANDO' || state.status === 'AGUARDANDO');
  const rawStatus = cdpCheck.connected
    ? completedRun && state.status === 'ATIVO' ? 'AGUARDANDO' : state.status
    : browserConfigured
      ? 'DESCONECTADO'
      : isRunningWithoutBrowser
        ? state.status
        : 'DESCONECTADO';
  const statusMap: Record<string, WorkerStatus['status']> = {
    RUNNING: 'PROCESSANDO',
    PROCESSANDO: 'PROCESSANDO',
    IDLE: 'AGUARDANDO',
    ATIVO: 'ATIVO',
    PAUSED: 'PAUSADO',
    PAUSADO: 'PAUSADO',
    ERROR: 'ERRO',
    ERRO: 'ERRO',
    DISCONNECTED: 'DESCONECTADO',
    DESCONECTADO: 'DESCONECTADO',
  };
  const automationsActive = rawStatus === 'PROCESSANDO' || rawStatus === 'ATIVO';
  const chromeOnlyWarning = (state.activity?.toLowerCase().includes('chrome') || state.lastError?.toLowerCase().includes('chrome')) && !browserConfigured;
  const sanitizedActivity = isRunningWithoutBrowser && chromeOnlyWarning ? 'Busca de empresas em andamento' : state.activity;
  const sanitizedLastError = browserConfigured ? state.lastError : null;

  return {
    status: statusMap[rawStatus] ?? 'AGUARDANDO',
    chromeConnected: cdpCheck.connected,
    instagramProfile: cdpCheck.username,
    // Antes exigia cdpCheck.connected aqui, o que travava os botoes
    // Iniciar/Pausar (e deixava a tela parecendo "parada") sempre que a
    // automacao roda em modo Geoapify-only (sem Chrome), que e um modo
    // suportado. rawStatus ja trata corretamente o caso sem Chrome (via
    // isRunningWithoutBrowser acima), entao basta usar automationsActive
    // como calculado.
    automationsActive,
    dailyLimit: counter.limit,
    sentToday: counter.count,
    queueSize: Number(queueResult[0]?.count ?? 0),
    activity: sanitizedActivity,
    dryRun: state.dryRun ?? true,
    lastError: sanitizedLastError,
    currentLeadName: currentWorkerLeadName,
    previewScreenshot: workerPreviewScreenshot,
  };
}

export async function getRecentWorkerActivities(limit = 25): Promise<WorkerLogEntry[]> {
  return db
    .select({
      id: activities.id,
      type: activities.type,
      channel: activities.channel,
      content: activities.content,
      leadName: leads.businessName,
      createdAt: activities.createdAt,
    })
    .from(activities)
    .leftJoin(leads, eq(activities.leadId, leads.id))
    .orderBy(desc(activities.createdAt))
    .limit(limit);
}

export async function pauseWorker() {
  await setWorkerState({ status: 'PAUSADO', activity: 'Pausado manualmente', pausedReason: 'Pausa manual' });
  return { success: true, message: 'Automacao pausada.' };
}

export async function startWorker(): Promise<{ success: boolean; message?: string; error?: string }> {
  if (activeWorkerRun) {
    return { success: true, message: 'Automacao ja esta em execucao.' };
  }

  const s = await getSettings();
  await setWorkerState({
    status: 'ATIVO',
    activity: 'Inicio solicitado',
    chromeConnected: false,
    instagramProfile: null,
    lastError: null,
    pausedReason: null,
    dryRun: s?.prospectionDryRun ?? true,
    startedAt: new Date(),
  });
  activeWorkerRun = runWorkerLoop().finally(() => {
    activeWorkerRun = null;
  });
  return { success: true, message: 'Automacao iniciada. O progresso sera atualizado nesta tela.' };
}

// Fila de envio automatico do modo SEMIAUTOMATICO. A "fila" nao e uma tabela
// separada: e simplesmente todo lead com pipelineStage em
// QUALIFICADO/PRONTO PARA CONTATO/AGUARDANDO_CONTATO (a mesma definicao ja
// usada em getWorkerStatus para contar o tamanho da fila). Por isso, quando
// o envio muda o estagio para CONTATO REALIZADO, o lead sai da fila sozinho;
// e se o usuario regredir o estagio manualmente de volta para um desses tres,
// ele volta a aparecer na fila sozinho tambem — sem nenhuma logica extra de
// "readicionar".
async function processAutomaticSendQueueOnce() {
  const s = await getSettings();
  if ((s?.operationalMode ?? 'ASSISTIDO') !== 'SEMIAUTOMATICO') return;

  const dryRun = s?.prospectionDryRun ?? true;
  if (dryRun) {
    // Modo de teste: o worker continua descobrindo e preparando rascunhos de
    // mensagem (via runProspectingOnce), mas nao envia nada sozinho. Isso
    // evita reprocessar os mesmos leads a cada ciclo so para regenerar
    // rascunho, ja que em modo de teste o estagio nunca avanca para tirar o
    // lead da fila.
    return;
  }

  const cdpCheck = await checkChromeConnection();
  if (!cdpCheck.connected || !cdpCheck.username) {
    await setWorkerState({ activity: 'Modo semi-automático aguardando Chrome com Instagram conectado para enviar as mensagens da fila.' });
    return;
  }

  const counter = await getCounter();
  if (counter.count >= counter.limit) return;

  const queued = await db
    .select({ id: leads.id })
    .from(leads)
    .where(sql`${leads.pipelineStage} IN ('QUALIFICADO', 'PRONTO PARA CONTATO', 'AGUARDANDO_CONTATO') AND ${leads.doNotContact} = 0 AND ${leads.instagramUsername} IS NOT NULL`)
    .limit(Math.max(1, counter.limit - counter.count));

  const intervalMs = Math.max(s?.minActionIntervalSeconds ?? 90, 15) * 1000;

  for (const { id: leadId } of queued) {
    const freshState = await ensureWorkerState();
    if (freshState.status === 'PAUSADO') break;

    const freshCounter = await getCounter();
    if (freshCounter.count >= freshCounter.limit) break;

    try {
      // sendFirstDmViaBrowser prepara e digita a mensagem (mesma funcao usada
      // no fluxo manual de "Preparar DM"); confirmPreparedDmViaBrowser e quem
      // efetivamente aperta Enter e atualiza o pipeline para CONTATO
      // REALIZADO. No fluxo manual, um humano ve o print da conversa entre
      // essas duas etapas antes de confirmar; no modo semi-automatico as duas
      // etapas sao encadeadas sem essa revisao, pois o objetivo aqui e
      // exatamente o envio nao supervisionado.
      const prepared = await sendFirstDmViaBrowser(leadId);
      if (prepared.success && prepared.prepared && !prepared.dryRun && prepared.message) {
        await confirmPreparedDmViaBrowser(leadId, prepared.message);
      }
    } catch (err: any) {
      console.error('[ERROR] Envio automatico falhou para lead', leadId, err?.message ?? err);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function runWorkerLoop() {
  const intervalMs = Math.max(Number(process.env.BROWSER_WORKER_INTERVAL_MS ?? 60000), 15000);

  while (true) {
    const state = await ensureWorkerState();
    if (state.status === 'PAUSADO') return { success: true, message: 'Automacao pausada.' };

    const result = await runProspectingOnce();
    if (!result.success) {
      await setWorkerState({
        status: 'ERRO',
        activity: result.message ?? 'Falha na busca da IA',
        lastError: result.error ?? null,
      });
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }

    try {
      await processAutomaticSendQueueOnce();
    } catch (err: any) {
      console.error('[ERROR] Falha no ciclo de envio automatico:', err?.message ?? err);
    }

    const postSendState = await ensureWorkerState();
    if (postSendState.status === 'PAUSADO') return { success: true, message: 'Automacao pausada.' };

    await setWorkerState({
      status: 'AGUARDANDO',
      activity: `Proxima busca em ${Math.round(intervalMs / 1000)} segundos`,
    });
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function sanitizeInstagramUsername(value: string | null | undefined) {
  if (!value) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  const withoutAt = raw.replace(/^@/, '');
  const withoutBaseUrl = withoutAt.replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '').replace(/^https?:\/\/(?:www\.)?instagram\.com$/i, '');
  const normalized = withoutBaseUrl.split(/[/?#]/)[0].trim();

  if (!normalized || !/^[a-zA-Z0-9._]+$/.test(normalized)) return null;
  return normalized.toLowerCase();
}

function getInstagramUsernameFromUrl(url: string | null | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (!segments.length) return null;
    const firstSegment = sanitizeInstagramUsername(segments[0]);
    const ignored = new Set(['accounts', 'explore', 'reels', 'p', 'direct', 'stories', 'tags', 'about', 'privacy', 'terms', 'login', 'signup']);
    if (!firstSegment || ignored.has(firstSegment.toLowerCase())) return null;
    return firstSegment;
  } catch {
    return null;
  }
}

function hasInstagramGuardPage(content: string) {
  return [
    'Help Us Verify',
    'Log In to Instagram',
    'Log in',
    'Entrar no Instagram',
    'Cadastre-se',
    'Sign up',
    'temporariamente bloqueada',
    'temporarily locked',
    'challenge',
    'captcha',
  ].some((needle) => content.toLowerCase().includes(needle.toLowerCase()));
}

async function createCandidate(username: string, term: string, city: string | null, segment: string | null, representativeUsername?: string | null) {
  const cleanUsername = sanitizeInstagramUsername(username);
  if (!cleanUsername || cleanUsername.length < 2) return null;
  const configuredUsername = sanitizeInstagramUsername(representativeUsername || process.env.INSTAGRAM_USERNAME);
  if (configuredUsername && cleanUsername === configuredUsername) return null;

  const existing = await db.select({ id: leads.id }).from(leads).where(eq(leads.instagramUsername, cleanUsername)).limit(1);
  if (existing.length > 0) return null;

  const now = new Date();
  const leadId = crypto.randomUUID();
  await db.insert(leads).values({
    id: leadId,
    businessName: `@${cleanUsername}`,
    instagramUsername: cleanUsername,
    instagramUrl: `https://www.instagram.com/${cleanUsername}/`,
    city,
    category: segment,
    source: 'INSTAGRAM_CDP',
    pipelineStage: 'DESCOBERTO',
    qualificationStatus: 'DESCOBERTO',
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(activities).values({
    id: crypto.randomUUID(),
    leadId,
    type: 'LEAD_CREATED',
    channel: 'INSTAGRAM',
    content: `[WORKER] Perfil encontrado em pesquisa: ${term}`,
    metadata: JSON.stringify({ source: 'INSTAGRAM_CDP', term }),
    createdAt: now,
  });

  console.log('[WORKER] Perfil encontrado', cleanUsername);
  return leadId;
}

export async function runProspectingOnce() {
  const s = await getSettings();
  const sources = parseJsonList(s?.prospectingSources);
  const enabledSources = sources.length > 0 ? sources : ['GEOAPIFY'];

  const cities = parseJsonList(s?.prospectingCities);
  const segments = parseJsonList(s?.prospectingSegments);
  const configuredTerms = parseJsonList(s?.prospectingSearchTerms);
  const terms = configuredTerms.length > 0
    ? configuredTerms
    : segments.flatMap((segment) => (cities.length ? cities.map((city) => `${segment} ${city}`) : [segment]));

  if (!s || (terms.length === 0 && !enabledSources.includes('MANUAL'))) {
    const error = 'Configure cidades, segmentos ou termos de pesquisa antes de iniciar.';
    await setWorkerState({ status: 'PAUSADO', activity: error, lastError: error, pausedReason: 'Configuracao incompleta' });
    return { success: false, error, message: error };
  }

  const maxProfiles = s.maxProfilesPerRun ?? 20;
  const minScore = s.minScoreForQueue ?? 0;
  const intervalMs = Math.max(s.minActionIntervalSeconds ?? 90, 15) * 1000;
  const requiresInstagramBrowser = enabledSources.includes('INSTAGRAM');
  const hasAlternateSource = enabledSources.some((source) => source !== 'INSTAGRAM');

  if (requiresInstagramBrowser) {
    const cdpCheck = await checkChromeConnection();
    if (!cdpCheck.connected && !hasAlternateSource) {
      const message = cdpCheck.error ?? 'Chrome indisponivel para a busca publica do Instagram. Configure CHROME_EXECUTABLE_PATH ou deixe o Chrome acessivel localmente.';
      await setWorkerState({ status: 'DESCONECTADO', activity: message, lastError: message, pausedReason: 'Chrome inacessivel para busca' });
      return { success: false, error: message, message };
    }
    if (!cdpCheck.connected) {
      await setWorkerState({ activity: `Instagram indisponivel; seguindo com outras fontes`, lastError: cdpCheck.error ?? null });
    }
  }

  let browser;
  let page;
  let backgroundWorkerBrowser: Browser | undefined;
  const leadIds: string[] = [];
  let discovered = 0;
  let qualified = 0;

  try {
    console.log('[WORKER] Pesquisa iniciada');
    currentWorkerLeadName = null;
    workerPreviewScreenshot = null;
    await setWorkerState({ status: 'PROCESSANDO', activity: 'Pesquisa iniciada', lastError: null, dryRun: s.prospectionDryRun ?? true });
    if (enabledSources.includes('GEOAPIFY')) {
      await setWorkerState({ activity: `Buscando empresas via Geoapify em ${cities[0] ?? s.city ?? 'regiao configurada'}` });
      const geoapifyResult = await discoverGeoapifyPlaces(s);
      leadIds.push(...geoapifyResult.leadIds);
      discovered += geoapifyResult.found;
      if (geoapifyResult.errors.length > 0) await setWorkerState({ lastError: geoapifyResult.errors.join(' | ') });
      await setWorkerState({ activity: `${geoapifyResult.found} empresas encontradas no Geoapify` });
    }

    if (enabledSources.includes('MANUAL')) {
      const manualLeads = await db.select({ id: leads.id }).from(leads)
        .where(and(eq(leads.source, 'MANUAL_CSV'), eq(leads.pipelineStage, 'DESCOBERTO')))
        .limit(Math.max((s.maxProfilesPerRun ?? 20) - leadIds.length, 0));
      leadIds.push(...manualLeads.map((lead) => lead.id));
      discovered += manualLeads.length;
      await setWorkerState({ activity: `${manualLeads.length} empresas carregadas da lista manual` });
    }

    if (enabledSources.includes('INSTAGRAM')) {
      const cdpCheck = await checkChromeConnection();
      if (!cdpCheck.connected) {
        const message = cdpCheck.error ?? 'Chrome CDP indisponivel.';
        const hasAlternateSource = enabledSources.some((source) => source !== 'INSTAGRAM');
        if (leadIds.length === 0 && !hasAlternateSource) {
          await setWorkerState({ status: 'DESCONECTADO', activity: message, lastError: message });
          return { success: false, error: message, message };
        }
        await setWorkerState({ activity: `Instagram indisponivel; seguindo com ${leadIds.length} leads de outras fontes`, lastError: message });
      } else {
        const background = await createBackgroundInstagramPage();
        backgroundWorkerBrowser = background.browser;
        browser = background.browser;
        page = background.page;
      }
    }

    const instagramPage = page;
    for (const term of enabledSources.includes('INSTAGRAM') && instagramPage ? terms : []) {
      const state = await ensureWorkerState();
      if (state.status === 'PAUSADO') break;
      if (discovered >= maxProfiles) break;

      const searchTerms = Array.from(new Set([
        term,
        term.replace(/\s+/g, ' '),
        term.replace(/\s+(de|da|do|dos|das|e|em)\s+/gi, ' '),
        `${term} maceio`,
        `${term} alagoas`,
      ])).filter(Boolean);

      await setWorkerState({ activity: `Pesquisando ${term}` });
      let usernames: string[] = [];

      for (const searchTerm of searchTerms) {
        const candidates = await searchInstagramUsernames(instagramPage!, searchTerm, cities[0] ?? s.city ?? null);
        usernames.push(...candidates);
        if (usernames.length >= 10) break;
      }

      if (usernames.length === 0) {
        const hashtag = term.replace(/[^a-zA-Z0-9]/g, '');
        if (hashtag.length >= 3) {
          await setWorkerState({ activity: `Buscando hashtag #${hashtag}` });
          await instagramPage!.goto(`https://www.instagram.com/explore/tags/${hashtag}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await instagramPage!.waitForTimeout(3000);
          usernames = await instagramPage!.evaluate(() => {
            const ignored = new Set(['explore', 'accounts', 'reels', 'p', 'direct', 'web', 'popular', 'legal', 'about', 'privacy', 'terms', 'stories', 'saved', 'notifications', 'profile']);
            return Array.from(new Set(
              Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'))
                .map((anchor) => anchor.getAttribute('href') ?? '')
                .filter((href) => /^\/[A-Za-z0-9._]+\/?$/.test(href))
                .map((href) => href.split('/').filter(Boolean)[0])
                .filter((value) => Boolean(value) && !ignored.has(value.toLowerCase()) && /^[A-Za-z0-9._]+$/.test(value))
            )).slice(0, 25);
          });
        }
      }

      if (usernames.length === 0) {
        await setWorkerState({ activity: `Nenhum perfil encontrado para ${term}` });
      }

      for (const username of Array.from(new Set(usernames))) {
        if (discovered >= maxProfiles) break;
        const leadId = await createCandidate(username, term, cities[0] ?? s.city ?? null, segments[0] ?? null, s.instagram);
        if (!leadId) continue;
        leadIds.push(leadId);
        discovered++;
      }

      if (intervalMs > 0 && discovered < maxProfiles) {
        await setWorkerState({ status: 'AGUARDANDO', activity: 'Aguardando intervalo minimo' });
        await instagramPage!.waitForTimeout(Math.min(intervalMs, 30000));
        await setWorkerState({ status: 'PROCESSANDO' });
      }
    }

    // Backfill profiles created by earlier public-search runs. Those records
    // already contain the handle, but were never scraped by the old flow.
    const incompleteInstagramLeads = enabledSources.includes('INSTAGRAM')
      ? await db
          .select({ id: leads.id })
          .from(leads)
          .where(and(
            eq(leads.source, 'INSTAGRAM_CDP'),
            isNotNull(leads.instagramUsername),
            sql`${leads.profileAccepted} IS NOT 1`,
          ))
          .orderBy(desc(leads.createdAt))
          .limit(maxProfiles)
      : [];

    for (const incompleteLead of incompleteInstagramLeads) {
      if (!leadIds.includes(incompleteLead.id)) leadIds.push(incompleteLead.id);
    }

    let enrichmentPage = instagramPage;
    if (!enrichmentPage && leadIds.some(Boolean)) {
      const cdpCheck = await checkChromeConnection();
      if (cdpCheck.connected) {
        const background = await createBackgroundInstagramPage();
        backgroundWorkerBrowser = background.browser;
        browser = background.browser;
        enrichmentPage = background.page;
      }
    }

    for (const leadId of leadIds) {
      const state = await ensureWorkerState();
      if (state.status === 'PAUSADO') break;
      const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
      if (!lead) continue;
      currentWorkerLeadName = lead.businessName;

      // Leads discovered by the public Instagram search already have a username.
      // They still need to be opened and scraped so the CRM fields are populated.
      if (enrichmentPage) {
        await setWorkerState({ activity: `Enriquecendo dados de ${lead.businessName}` });
        try {
          const enriched = await enrichLeadWithInstagram(enrichmentPage, lead);
          if (enriched.updated) {
            await setWorkerState({ activity: `@${enriched.profile?.username} encontrado para ${lead.businessName}` });
          }
          if (!enrichmentPage.isClosed()) {
            const preview = await enrichmentPage.screenshot({ type: 'jpeg', quality: 35, fullPage: false });
            workerPreviewScreenshot = `data:image/jpeg;base64,${preview.toString('base64')}`;
          }
        } catch (err: any) {
          console.warn('[WORKER] Enrichment failed:', err?.message);
        }
        await enrichmentPage.waitForTimeout(1500);
      }

      await setWorkerState({ activity: `Analisando ${lead.businessName}` });
      const analysis = await analyzeLeadAction(leadId);
      if (analysis.success && typeof analysis.result?.score === 'number' && analysis.result.score >= minScore) {
        const preContactStages = ['DESCOBERTO', 'ANALISANDO', 'NOVO', 'PESQUISANDO', 'QUALIFICADO', 'AGUARDANDO_CONTATO', 'PRONTO PARA CONTATO'];
        if (preContactStages.includes(lead.pipelineStage)) {
          await db.update(leads).set({ pipelineStage: 'QUALIFICADO', updatedAt: new Date() }).where(and(eq(leads.id, leadId), inArray(leads.pipelineStage, preContactStages)));
        }
        const messageResult = await generateMessageAction(leadId);
        qualified++;
        await setWorkerState({ activity: `Lead aprovado — score ${analysis.result.score}`, lastError: messageResult.success ? null : messageResult.error });
      } else {
        const preContactStages = ['DESCOBERTO', 'ANALISANDO', 'NOVO', 'PESQUISANDO', 'QUALIFICADO', 'AGUARDANDO_CONTATO', 'PRONTO PARA CONTATO'];
        if (preContactStages.includes(lead.pipelineStage)) {
          await db.update(leads).set({ pipelineStage: 'DESCARTADO', updatedAt: new Date() }).where(and(eq(leads.id, leadId), inArray(leads.pipelineStage, preContactStages)));
        }
        await setWorkerState({ activity: `${lead.businessName} descartado após análise`, lastError: analysis.error ?? null });
      }
    }

    if (instagramPage) await instagramPage.close();
    if (enrichmentPage && enrichmentPage !== instagramPage) await enrichmentPage.close();
    if (backgroundWorkerBrowser?.isConnected()) await backgroundWorkerBrowser.close();
    await releaseBrowserConnection(browser);
    await setWorkerState({ status: 'AGUARDANDO', activity: `Execucao concluida: ${discovered} encontrados, ${qualified} qualificados` });
    currentWorkerLeadName = null;
    return { success: true, message: `Execucao concluida: ${discovered} encontrados, ${qualified} qualificados.` };
  } catch (err: any) {
    if (backgroundWorkerBrowser?.isConnected()) await backgroundWorkerBrowser.close().catch(() => undefined);
    await releaseBrowserConnection(browser);
    const error = `Erro no Browser Worker: ${err?.message ?? 'falha desconhecida'}`;
    await setWorkerState({ status: 'ERRO', activity: 'Erro durante execucao', lastError: error });
    console.error('[ERROR]', error);
    return { success: false, error, message: error };
  }
}

export async function enrichLeadViaBrowser(leadId: string): Promise<{ success: boolean; error?: string; username?: string; followers?: number | null; method?: string | null }> {
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
  if (!lead) return { success: false, error: 'Lead nao encontrado.' };

  let browser: Browser | undefined;
  try {
    try {
      const background = await createBackgroundInstagramPage();
      browser = background.browser;
      const result = await enrichLeadWithInstagram(background.page, lead);
      await background.page.close();
      await browser.close();

      if (!result.updated || !result.profile) {
        return { success: false, error: `Nao foi possivel encontrar Instagram para ${lead.businessName}. Tente buscar manualmente ou importar via CSV.` };
      }

      return {
        success: true,
        username: result.profile.username,
        followers: result.profile.followers,
        method: result.method,
      };
    } catch (err: any) {
      if (browser?.isConnected()) await browser.close().catch(() => undefined);
      return { success: false, error: `Nao foi possivel conectar ao navegador: ${err?.message ?? String(err)}` };
    }
  } catch (err: any) {
    if (browser?.isConnected()) await browser.close().catch(() => undefined);
    return { success: false, error: err?.message ?? 'Falha ao enriquecer lead.' };
  }
}

export type DmPreparationResult = {
  success: boolean;
  error?: string;
  dryRun?: boolean;
  prepared?: boolean;
  message?: string;
  screenshot?: string;
};

export async function previewInstagramProfileViaBrowser(leadId: string): Promise<{ success: boolean; error?: string; screenshot?: string }> {
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
  const username = sanitizeInstagramUsername(lead?.instagramUsername);
  if (!username) return { success: false, error: 'Este lead não possui Instagram confirmado ou o valor está inválido.' };

  let backgroundBrowser: Browser | undefined;
  try {
    const background = await createBackgroundInstagramPage();
    backgroundBrowser = background.browser;
    await background.page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await background.page.waitForTimeout(2500);
    const bodyText = await background.page.locator('body').innerText().catch(() => '');
    if (hasInstagramGuardPage(bodyText)) return { success: false, error: 'O Instagram solicitou login ou verificação da sessão.' };
    const screenshot = await background.page.screenshot({ type: 'jpeg', quality: 50, fullPage: false });
    return { success: true, screenshot: `data:image/jpeg;base64,${screenshot.toString('base64')}` };
  } catch (err: any) {
    return { success: false, error: `Não foi possível visualizar o perfil: ${err?.message ?? 'falha desconhecida'}` };
  } finally {
    if (backgroundBrowser?.isConnected()) await backgroundBrowser.close().catch(() => undefined);
  }
}

export async function sendFirstDmViaBrowser(leadId: string, requestedMessage?: string): Promise<DmPreparationResult> {
  const s = await getSettings();
  const dryRun = s?.prospectionDryRun ?? process.env.PROSPECTION_DRY_RUN !== 'false';
  const counter = await getCounter();

  if (counter.count >= counter.limit) {
    const error = `Limite diario de envio (${counter.limit} DMs) atingido para hoje.`;
    await setWorkerState({ status: 'PAUSADO', activity: 'Pausado por limite diario', lastError: error, pausedReason: 'Limite diario' });
    return { success: false, error };
  }

  let lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
  if (!lead) return { success: false, error: 'Lead nao encontrado.' };
  if (lead.doNotContact) return { success: false, error: 'Lead marcado como NAO CONTATAR.' };

  const sanitizedLeadUsername = sanitizeInstagramUsername(lead.instagramUsername);
  if (!sanitizedLeadUsername) {
    const enriched = await enrichLeadViaBrowser(leadId);
    if (!enriched.success) {
      return { success: false, error: enriched.error ?? 'Lead nao possui usuario de Instagram válido. Use "Buscar Instagram" antes de enviar.' };
    }
    const refreshed = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
    const refreshedUsername = sanitizeInstagramUsername(refreshed?.instagramUsername);
    if (!refreshedUsername) {
      return { success: false, error: 'Lead nao possui usuario de Instagram válido.' };
    }
    lead = { ...refreshed, instagramUsername: refreshedUsername };
  } else {
    lead = { ...lead, instagramUsername: sanitizedLeadUsername };
  }

  const cdpCheck = await checkChromeConnection();
  if (!cdpCheck.connected || !cdpCheck.username) {
    // If we're running in dryRun mode, allow enrichment and message generation
    // to proceed without an authenticated Instagram session (no actual send).
    if (dryRun) {
      const verified = await enrichLeadViaBrowser(leadId);
      if (!verified.success) {
        return { success: false, error: `Instagram não confirmado para ${lead.businessName}: ${verified.error ?? 'nenhuma evidência suficiente no perfil.'}` };
      }
      const verifiedLead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
      if (!verifiedLead?.instagramUsername) {
        return { success: false, error: `Instagram não confirmado para ${lead.businessName}.` };
      }
      lead = verifiedLead;
    } else {
      const verified = await enrichLeadViaBrowser(leadId);
      if (!verified.success) {
        return { success: false, error: `Instagram não confirmado para ${lead.businessName}: ${verified.error ?? 'nenhuma evidência suficiente no perfil.'}` };
      }
      const verifiedLead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
      if (!verifiedLead?.instagramUsername) {
        return { success: false, error: `Instagram não confirmado para ${lead.businessName}.` };
      }
      lead = verifiedLead;
      return {
        success: false,
        error: cdpCheck.error ?? 'Instagram sem sessão autenticada. Abra o Instagram logado no Chrome conectado ao CDP e tente novamente.',
      };
    }
  }

  let messageToSend = requestedMessage?.trim() ?? '';
  if (!messageToSend) {
    const lastGenerated = await db
      .select()
      .from(activities)
      .where(sql`${activities.leadId} = ${leadId} AND ${activities.type} = 'MESSAGE_GENERATED'`)
      .orderBy(desc(activities.createdAt))
      .limit(1);

    if (lastGenerated[0]?.content) messageToSend = lastGenerated[0].content;
  }

  if (!messageToSend) {
    const genResult = await generateMessageAction(leadId);
    if (!genResult.success || !genResult.message) {
      return { success: false, error: `Falha ao gerar mensagem via IA: ${genResult.error}` };
    }
    messageToSend = genResult.message;
  }

  if (messageToSend.length > 1000) {
    return { success: false, error: 'A mensagem excede o limite de 1.000 caracteres do envio.' };
  }

  const now = new Date();
  if (dryRun) {
    await db.insert(activities).values({
      id: crypto.randomUUID(),
      leadId,
      type: 'MESSAGE_GENERATED',
      channel: 'INSTAGRAM',
      direction: 'OUTBOUND',
      content: messageToSend,
      metadata: JSON.stringify({ dryRun: true, provider: 'BROWSER', result: 'NOT_SENT' }),
      createdAt: now,
    });
    await setWorkerState({ activity: 'MODO DE TESTE: envio real bloqueado', dryRun: true });
    return { success: true, dryRun: true, prepared: true, message: messageToSend };
  }

  let browser: Browser | undefined;

  try {
    await setWorkerState({ status: 'PROCESSANDO', activity: `Enviando DM para @${lead.instagramUsername}` });
    const background = await createBackgroundInstagramPage();
    browser = background.browser;
    const context = background.context;
    let page = background.page;
    const cleanUsername = sanitizeInstagramUsername(lead.instagramUsername) ?? '';
    if (!cleanUsername) {
      await browser.close();
      return { success: false, error: 'Usuario do Instagram inválido para preparar a conversa.' };
    }

    await page.goto(`https://www.instagram.com/${cleanUsername}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const pageContent = await page.locator('body').innerText();
    if (hasInstagramGuardPage(pageContent)) {
      const error = `Instagram solicitou verificação/login em ${cleanUsername}. Confirme a sessão do Instagram e tente novamente.`;
      await setWorkerState({ status: 'PAUSADO', activity: error, lastError: error, pausedReason: 'Protecao do Instagram' });
      await browser.close();
      return { success: false, error };
    }

    const messageButtonSelectors = [
      'button:has-text("Enviar mensagem")',
      'button:has-text("Mensagem")',
      'button:has-text("Message")',
      'div[role="button"]:has-text("Enviar mensagem")',
      'div[role="button"]:has-text("Mensagem")',
      'div[role="button"]:has-text("Message")',
    ];

    let clicked = false;
    for (const selector of messageButtonSelectors) {
      const btn = page.locator(selector).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        const pagesBeforeClick = new Set(context.pages());
        await btn.click();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const openedPage = context.pages().find((candidate) => !pagesBeforeClick.has(candidate) && !candidate.isClosed());
        if (openedPage) page = openedPage;
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      await page.close();
      await browser.close();
      const error = `Botao de mensagem nao encontrado para @${cleanUsername}.`;
      await setWorkerState({ status: 'ERRO', activity: error, lastError: error });
      return { success: false, error };
    }

    if (page.isClosed()) {
      const replacement = context.pages().find((candidate) => !candidate.isClosed() && candidate.url().includes('instagram.com'));
      if (!replacement) throw new Error('A conversa do Instagram foi fechada antes de ser carregada.');
      page = replacement;
    }
    await page.waitForTimeout(3500);
    const chatInputs = page.locator('div[contenteditable="true"], p[contenteditable="true"], textarea, [role="textbox"]');
    let chatInput = chatInputs.first();
    for (let index = 0; index < await chatInputs.count(); index++) {
      const candidate = chatInputs.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        chatInput = candidate;
        break;
      }
    }
    if ((await chatInputs.count()) === 0 || !(await chatInput.isVisible().catch(() => false))) {
      const chatPageText = await page.locator('body').innerText().catch(() => '');
      await page.close();
      await browser.close();
      const messagingBlocked = /n[aã]o (?:pode|permite).*mensagem|doesn.?t allow.*message|can.?t message|unable to message/i.test(chatPageText);
      const error = messagingBlocked
        ? `@${cleanUsername} não aceita mensagens de contas que não segue. Pule este lead ou tente outro canal.`
        : `Campo de digitação do chat não encontrado para @${cleanUsername}.`;
      await setWorkerState({ status: 'ERRO', activity: error, lastError: error });
      return { success: false, error };
    }

    await chatInput.focus();
    await chatInput.fill(messageToSend);
    await page.waitForTimeout(800);
    const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 45, fullPage: false });
    preparedDmPages.set(leadId, { page, browser });
    await setWorkerState({ status: 'AGUARDANDO', activity: `DM preparada para @${cleanUsername}; aguardando confirmação`, lastError: null });
    return {
      success: true,
      prepared: true,
      message: messageToSend,
      screenshot: `data:image/jpeg;base64,${screenshotBuffer.toString('base64')}`,
    };
  } catch (err: any) {
    if (browser?.isConnected()) await browser.close().catch(() => undefined);
    const error = `Erro durante execucao do Playwright: ${err?.message ?? 'falha desconhecida'}`;
    await setWorkerState({ status: 'ERRO', activity: 'Falha no envio', lastError: error });
    return { success: false, error };
  }
}

export async function confirmPreparedDmViaBrowser(leadId: string, requestedMessage: string): Promise<{ success: boolean; error?: string; dryRun?: boolean }> {
  const messageToSend = requestedMessage.trim();
  if (!messageToSend) return { success: false, error: 'A mensagem está vazia.' };

  const s = await getSettings();
  const dryRun = s?.prospectionDryRun ?? process.env.PROSPECTION_DRY_RUN !== 'false';
  if (dryRun) return { success: true, dryRun: true };

  const counter = await getCounter();
  if (counter.count >= counter.limit) return { success: false, error: `Limite diário de envio (${counter.limit} DMs) atingido.` };

  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
  if (!lead?.instagramUsername) return { success: false, error: 'Lead ou Instagram não encontrado.' };
  if (lead.doNotContact) return { success: false, error: 'Lead marcado como NÃO CONTATAR.' };

  try {
    const prepared = preparedDmPages.get(leadId);
    const page = prepared?.page && !prepared.page.isClosed() ? prepared.page : null;
    if (!page) return { success: false, error: 'A conversa preparada não está mais aberta. Clique em “Preparar DM” novamente.' };

    const inputs = page.locator('div[contenteditable="true"], p[contenteditable="true"], textarea, [role="textbox"]');
    let chatInput = inputs.first();
    for (let index = 0; index < await inputs.count(); index++) {
      const candidate = inputs.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        chatInput = candidate;
        break;
      }
    }
    if (!(await chatInput.isVisible().catch(() => false))) {
      return { success: false, error: 'O campo da conversa não está mais disponível. Prepare a DM novamente.' };
    }

    const currentText = await chatInput.textContent().catch(() => '');
    if ((currentText ?? '').trim() !== messageToSend) await chatInput.fill(messageToSend);
    await chatInput.press('Enter');
    preparedDmPages.delete(leadId);
    await prepared?.browser.close().catch(() => undefined);

    const now = new Date();
    await db.update(leads).set({
      pipelineStage: 'CONTATO REALIZADO',
      conversationProvider: 'BROWSER',
      firstContactAt: lead.firstContactAt ?? now,
      lastContactAt: now,
      updatedAt: now,
    }).where(eq(leads.id, leadId));
    await db.insert(activities).values({
      id: crypto.randomUUID(), leadId, type: 'MESSAGE_SENT', channel: 'INSTAGRAM', direction: 'OUTBOUND',
      content: messageToSend,
      metadata: JSON.stringify({ provider: 'BROWSER', via: 'PLAYWRIGHT_CDP', confirmedInCrm: true }),
      createdAt: now,
    });
    await incrementCounter();
    await setWorkerState({ status: 'ATIVO', activity: `DM enviada para @${lead.instagramUsername}`, lastError: null });
    return { success: true };
  } catch (err: any) {
    const error = `Erro ao confirmar a DM: ${err?.message ?? 'falha desconhecida'}`;
    await setWorkerState({ status: 'ERRO', activity: 'Falha ao confirmar envio', lastError: error });
    return { success: false, error };
  }
}

export async function cancelPreparedDmViaBrowser(leadId: string) {
  const prepared = preparedDmPages.get(leadId);
  preparedDmPages.delete(leadId);
  if (prepared?.browser.isConnected()) await prepared.browser.close().catch(() => undefined);
  return { success: true };
}
