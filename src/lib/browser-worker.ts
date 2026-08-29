import { chromium, type Browser } from 'playwright';
import fs from 'fs';
import path from 'path';
import { db } from '@/db';
import { activities, dailyActionCounters, leads, settings, workerState } from '@/db/schema';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { analyzeLeadAction, generateMessageAction } from '@/app/actions/ai';
import { discoverGeoapifyPlaces } from '@/lib/prospecting-sources';
import { enrichLeadWithInstagram } from '@/lib/instagram-enrichment';

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

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getBrowserConnection() {
  if (cdpBrowser?.isConnected?.()) return cdpBrowser;
  if (!cdpConnectionPromise) {
    const cdpUrl = process.env.CHROME_CDP_URL || 'http://localhost:9222';
    cdpConnectionPromise = chromium.connectOverCDP(cdpUrl)
      .then((browser) => {
        cdpBrowser = browser;
        return browser;
      })
      .finally(() => {
        cdpConnectionPromise = null;
      });
  }
  return cdpConnectionPromise;
}

function releaseBrowserConnection(_browser: Browser | undefined) {
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

  if (!process.env.CHROME_CDP_URL && !process.env.CHROME_USER_DATA_DIR) {
    // Do not fail early when no env var is set. The user may be running Chrome
    // with the default local CDP port already active, which is the intended flow
    // for Instagram/browser automation.
  }

  try {
    const browser = await getBrowserConnection();
    const pages = browser.contexts().flatMap((context: any) => context.pages());
    const instagramPage = pages.find((page: any) => !page.isClosed() && page.url().includes('instagram.com'));
    const pageText = instagramPage
      ? await instagramPage.locator('body').innerText({ timeout: 3000 }).catch(() => '')
      : '';
    const pageUrl = instagramPage?.url?.() ?? null;
    const cookies = instagramPage
      ? await instagramPage.context().cookies('https://www.instagram.com').catch(() => [])
      : [];
    const hasSessionCookie = cookies.some((cookie: any) => cookie.name === 'sessionid' && cookie.value);
    const usernameFromUrl = getInstagramUsernameFromUrl(pageUrl);
    const isGuardPage = hasInstagramGuardPage(pageText);
    const hasValidInstagramPage = !!instagramPage && !!pageText && !isGuardPage;
    const username = hasValidInstagramPage
      ? (usernameFromUrl || process.env.INSTAGRAM_USERNAME || 'Sessao ativa')
      : null;
    const connected = !!instagramPage && hasValidInstagramPage && (hasSessionCookie || !!usernameFromUrl || !!process.env.INSTAGRAM_USERNAME || !isGuardPage);
    const error = connected
      ? undefined
      : 'Chrome conectado, mas nenhuma sessao valida do Instagram foi detectada. Abra o Instagram na mesma janela do Chrome com CDP e esteja logado.';
    releaseBrowserConnection(browser);
    await setWorkerState({ chromeConnected: connected, instagramProfile: username, lastError: error ?? null });
    return { connected, username, error };
  } catch (err: any) {
    const error = `Nao foi possivel conectar ao Chrome CDP (${cdpUrl}). Inicie o Chrome com remote debugging e execute o worker fora da Vercel.`;
    cdpBrowser = null;
    cdpConnectionPromise = null;
    await setWorkerState({ chromeConnected: false, lastError: error, status: 'DESCONECTADO' });
    console.error('[ERROR] CDP desconectado:', err?.message ?? err);
    return { connected: false, username: null, error };
  }
}

export async function testWorkerReadiness() {
  const [cdpCheck, s] = await Promise.all([checkChromeConnection(), getSettings()]);
  const configuredTerms = parseJsonList(s?.prospectingSearchTerms).length > 0 || parseJsonList(s?.prospectingSegments).length > 0;
  const openaiConfigured = !!process.env.OPENAI_API_KEY?.trim();
  const instagramEnabled = (parseJsonList(s?.prospectingSources).includes('INSTAGRAM') || (s?.prospectingSources ?? '').toUpperCase().includes('INSTAGRAM'));

  return {
    chrome: cdpCheck.connected,
    instagramSession: cdpCheck.connected && !!cdpCheck.username,
    backend: true,
    settings: !!s && configuredTerms,
    openaiConfigured,
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
    automationsActive: cdpCheck.connected && automationsActive,
    dailyLimit: counter.limit,
    sentToday: counter.count,
    queueSize: Number(queueResult[0]?.count ?? 0),
    activity: sanitizedActivity,
    dryRun: state.dryRun ?? true,
    lastError: sanitizedLastError,
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

    await setWorkerState({
      status: 'AGUARDANDO',
      activity: `Proxima busca em ${Math.round(intervalMs / 1000)} segundos`,
    });
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function getInstagramUsernameFromUrl(url: string | null | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (!segments.length) return null;
    const firstSegment = segments[0].replace(/^@/, '').trim();
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
  const cleanUsername = username.replace(/^@/, '').trim().toLowerCase();
  if (!cleanUsername || cleanUsername.length < 2) return null;
  const configuredUsername = (representativeUsername || process.env.INSTAGRAM_USERNAME)?.replace(/^@/, '').trim().toLowerCase();
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
      const message = cdpCheck.error ?? 'CDP do Chrome obrigatório para Instagram. Abra o Chrome com --remote-debugging-port=9222 e deixe-o aberto; o sistema não abre o navegador por você.';
      await setWorkerState({ status: 'DESCONECTADO', activity: message, lastError: message, pausedReason: 'CDP ausente para Instagram' });
      return { success: false, error: message, message };
    }
    if (!cdpCheck.connected) {
      await setWorkerState({ activity: `Instagram indisponivel; seguindo com outras fontes`, lastError: cdpCheck.error ?? null });
    }
  }

  let browser;
  let page;
  const leadIds: string[] = [];
  let discovered = 0;
  let duplicates = 0;
  let qualified = 0;

  try {
    console.log('[WORKER] Pesquisa iniciada');
    await setWorkerState({ status: 'PROCESSANDO', activity: 'Pesquisa iniciada', lastError: null, dryRun: s.prospectionDryRun ?? true });
    if (enabledSources.includes('GEOAPIFY')) {
      await setWorkerState({ activity: `Buscando empresas via Geoapify em ${cities[0] ?? s.city ?? 'regiao configurada'}` });
      const geoapifyResult = await discoverGeoapifyPlaces(s);
      leadIds.push(...geoapifyResult.leadIds);
      discovered += geoapifyResult.found;
      duplicates += geoapifyResult.duplicates;
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
        browser = await getBrowserConnection();
        const context = browser.contexts()[0] || await browser.newContext();
        page = await context.newPage();
      }
    }

    const instagramPage = page;
    for (const term of enabledSources.includes('INSTAGRAM') && instagramPage ? terms : []) {
      const state = await ensureWorkerState();
      if (state.status === 'PAUSADO') break;
      if (discovered >= maxProfiles) break;

      await setWorkerState({ activity: `Pesquisando ${term}` });
      await instagramPage!.goto(`https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(term)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await instagramPage!.waitForTimeout(3000);

      const content = await instagramPage!.locator('body').innerText();
      if (hasInstagramGuardPage(content)) {
        const error = 'Instagram solicitou login, captcha ou confirmacao de seguranca. A aba foi mantida aberta para voce validar a conta. Worker pausado.';
        await setWorkerState({ status: 'PAUSADO', activity: error, lastError: error, pausedReason: 'Protecao do Instagram' });
        await releaseBrowserConnection(browser);
        return { success: false, error, message: error };
      }

      let usernames: string[] = await instagramPage!.evaluate(() => {
        const ignored = new Set(['explore', 'accounts', 'reels', 'p', 'direct', 'web', 'popular', 'legal', 'about', 'privacy', 'terms']);
        return Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'))
          .map((anchor) => ({ href: anchor.getAttribute('href') ?? '', text: anchor.textContent?.trim() ?? '' }))
          .filter(({ href }) => /^\/[A-Za-z0-9._]+\/?$/.test(href))
          .map(({ href }) => href.split('/').filter(Boolean)[0])
          .filter((value) => value && !ignored.has(value.toLowerCase()))
          .slice(0, 25) as string[];
      });

      if (usernames.length === 0) {
        const hashtag = term.replace(/[^a-zA-Z0-9]/g, '');
        if (hashtag.length >= 3) {
          await setWorkerState({ activity: `Buscando hashtag #${hashtag}` });
          await instagramPage!.goto(`https://www.instagram.com/explore/tags/${hashtag}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await instagramPage!.waitForTimeout(3000);
          usernames = await instagramPage!.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'))
            .map((anchor) => anchor.getAttribute('href') ?? '')
            .filter((href) => /^\/[A-Za-z0-9._]+\/?$/.test(href))
            .map((href) => href.split('/').filter(Boolean)[0])
            .filter((value): value is string => Boolean(value))
            .slice(0, 25));
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

    let enrichmentPage = instagramPage;
    if (!enrichmentPage && leadIds.some(Boolean)) {
      const cdpCheck = await checkChromeConnection();
      if (cdpCheck.connected) {
        browser = browser ?? await getBrowserConnection();
        const context = browser.contexts()[0] || await browser.newContext();
        enrichmentPage = await context.newPage();
      }
    }

    for (const leadId of leadIds) {
      const state = await ensureWorkerState();
      if (state.status === 'PAUSADO') break;
      const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
      if (!lead) continue;

      if (enrichmentPage && !lead.instagramUsername) {
        await setWorkerState({ activity: `Buscando Instagram de ${lead.businessName}` });
        try {
          const enriched = await enrichLeadWithInstagram(enrichmentPage, lead);
          if (enriched.updated) {
            await setWorkerState({ activity: `@${enriched.profile?.username} encontrado para ${lead.businessName}` });
          }
        } catch (err: any) {
          console.warn('[WORKER] Enrichment failed:', err?.message);
        }
        await enrichmentPage.waitForTimeout(1500);
      }

      await setWorkerState({ activity: `Analisando ${lead.businessName}` });
      const analysis = await analyzeLeadAction(leadId);
      if (analysis.success && typeof analysis.result?.score === 'number' && analysis.result.score >= minScore) {
        await db.update(leads).set({ pipelineStage: 'QUALIFICADO', updatedAt: new Date() }).where(eq(leads.id, leadId));
        const messageResult = await generateMessageAction(leadId);
        qualified++;
        await setWorkerState({ activity: `Lead aprovado — score ${analysis.result.score}`, lastError: messageResult.success ? null : messageResult.error });
      } else {
        await db.update(leads).set({ pipelineStage: 'DESCARTADO', updatedAt: new Date() }).where(eq(leads.id, leadId));
        await setWorkerState({ activity: `${lead.businessName} descartado após análise`, lastError: analysis.error ?? null });
      }
    }

    if (instagramPage) await instagramPage.close();
    if (enrichmentPage && enrichmentPage !== instagramPage) await enrichmentPage.close();
    await releaseBrowserConnection(browser);
    await setWorkerState({ status: 'AGUARDANDO', activity: `Execucao concluida: ${discovered} encontrados, ${qualified} qualificados` });
    return { success: true, message: `Execucao concluida: ${discovered} encontrados, ${qualified} qualificados.` };
  } catch (err: any) {
    await releaseBrowserConnection(browser);
    const error = `Erro no Browser Worker: ${err?.message ?? 'falha desconhecida'}`;
    await setWorkerState({ status: 'ERRO', activity: 'Erro durante execucao', lastError: error });
    console.error('[ERROR]', error);
    return { success: false, error, message: error };
  }
}

export async function enrichLeadViaBrowser(leadId: string): Promise<{ success: boolean; error?: string; username?: string; followers?: number | null; method?: string | null }> {
  let lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
  if (!lead) return { success: false, error: 'Lead nao encontrado.' };

  let browser;
  try {
    // Try to get a browser connection (CDP or persistent context). Avoid
    // failing early on `checkChromeConnection()` so enrichment can run in
    // persistent contexts even when no CDP URL is provided.
    try {
      browser = await getBrowserConnection();
    } catch (err: any) {
      return { success: false, error: `Nao foi possivel conectar ao navegador: ${err?.message ?? String(err)}` };
    }
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = await context.newPage();
    const result = await enrichLeadWithInstagram(page, lead);
    await page.close();
    releaseBrowserConnection(browser);

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
    releaseBrowserConnection(browser);
    return { success: false, error: err?.message ?? 'Falha ao enriquecer lead.' };
  }
}

export async function sendFirstDmViaBrowser(leadId: string, requestedMessage?: string): Promise<{ success: boolean; error?: string; dryRun?: boolean }> {
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
  if (!lead.instagramUsername) {
    const enriched = await enrichLeadViaBrowser(leadId);
    if (!enriched.success) {
      return { success: false, error: enriched.error ?? 'Lead nao possui usuario de Instagram. Use "Buscar Instagram" antes de enviar.' };
    }
    const refreshed = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
    if (!refreshed?.instagramUsername) {
      return { success: false, error: 'Lead nao possui usuario de Instagram.' };
    }
    lead = refreshed;
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
    return { success: true, dryRun: true };
  }

  const cdpUrl = process.env.CHROME_CDP_URL || 'http://localhost:9222';
  let browser;

  try {
    await setWorkerState({ status: 'PROCESSANDO', activity: `Enviando DM para @${lead.instagramUsername}` });
    browser = await getBrowserConnection();
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = await context.newPage();
    const cleanUsername = lead.instagramUsername!.replace(/^@/, '').trim();

    await page.goto(`https://www.instagram.com/${cleanUsername}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const pageContent = await page.locator('body').innerText();
    if (hasInstagramGuardPage(pageContent)) {
      const error = `Instagram solicitou verificacao/login em ${cleanUsername}. A aba foi mantida aberta para voce validar a conta. Automacao pausada por seguranca.`;
      await setWorkerState({ status: 'PAUSADO', activity: error, lastError: error, pausedReason: 'Protecao do Instagram' });
      await releaseBrowserConnection(browser);
      return { success: false, error };
    }

    const messageButtonSelectors = [
      'button:has-text("Enviar mensagem")',
      'button:has-text("Mensagem")',
      'button:has-text("Message")',
      'div[role="button"]:has-text("Enviar mensagem")',
      'div[role="button"]:has-text("Mensagem")',
      'div[role="button"]:has-text("Message")',
      'a[href*="/direct/"]',
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
      await page.close();
      await releaseBrowserConnection(browser);
      const error = `Botao de mensagem nao encontrado para @${cleanUsername}.`;
      await setWorkerState({ status: 'ERRO', activity: error, lastError: error });
      return { success: false, error };
    }

    await page.waitForTimeout(5000);
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
      await page.close();
      await releaseBrowserConnection(browser);
      const error = `Campo de digitacao do chat nao encontrado para @${cleanUsername}.`;
      await setWorkerState({ status: 'ERRO', activity: error, lastError: error });
      return { success: false, error };
    }

    await chatInput.focus();
    await chatInput.fill(messageToSend);
    await chatInput.press('Enter');
    await page.waitForTimeout(3000);
    await page.close();
    await releaseBrowserConnection(browser);

    await db.update(leads).set({
      pipelineStage: 'CONTATO REALIZADO',
      conversationProvider: 'BROWSER',
      firstContactAt: lead.firstContactAt ?? now,
      lastContactAt: now,
      updatedAt: now,
    }).where(eq(leads.id, leadId));

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

    await incrementCounter();
    await setWorkerState({ status: 'ATIVO', activity: 'Envio concluido', lastError: null });
    return { success: true };
  } catch (err: any) {
    await releaseBrowserConnection(browser);
    const error = `Erro durante execucao do Playwright: ${err?.message ?? 'falha desconhecida'}`;
    await setWorkerState({ status: 'ERRO', activity: 'Falha no envio', lastError: error });
    return { success: false, error };
  }
}
