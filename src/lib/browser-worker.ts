import type { Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { db } from '@/db';
import { activities, dailyActionCounters, leads, settings, workerState } from '@/db/schema';
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { analyzeLeadAction } from '@/app/actions/ai';
import { discoverGeoapifyPlaces } from '@/lib/prospecting-sources';
import { enrichLeadWithInstagram, searchInstagramUsernames } from '@/lib/instagram-enrichment';
import { isAiConfigured } from '@/lib/ai-client';
import { hasVerifiableContact, NO_CONTACT_STAGE, PRE_CONTACT_STAGES } from '@/lib/lead-contact';
import { scheduleFollowUpAfterContact } from '@/lib/follow-ups';

// O pacote 'playwright' so pode ser carregado sob demanda: um import
// estatico no topo do arquivo quebra qualquer rota da Vercel que importe
// este modulo (mesmo sem nunca chamar chromium.*), porque o bundle da
// funcao serverless nao inclui os arquivos internos do playwright-core
// (ex.: coreBundle.js/browsers.json). Por isso o import e feito de forma
// preguicosa aqui, e bloqueado explicitamente quando rodando na Vercel.
async function getChromium() {
  const { chromium } = await import('playwright');
  return chromium;
}

function assertBrowserAutomationAvailable() {
  if (process.env.VERCEL === '1') {
    throw new Error(
      'Automacao de navegador (Playwright/Chrome CDP) nao esta disponivel neste ambiente (Vercel). '
      + 'Rode o worker localmente ou em um servidor dedicado com "npm run worker".'
    );
  }
}

// --- Proxy para um servico de navegador remoto -----------------------------
// Quando BROWSER_SERVICE_URL esta configurada (tipicamente na Vercel), as
// acoes que dependem de um Chrome real sao encaminhadas por HTTP para um
// processo persistente rodando em outra maquina (ver scripts/browser-service.ts).
// Quando nao esta configurada (uso local, ou no proprio servidor que hospeda
// o Chrome), as funcoes abaixo executam a logica local normalmente.
function isBrowserServiceConfigured() {
  return !!process.env.BROWSER_SERVICE_URL?.trim();
}

async function proxyToBrowserService<T>(path: string, body: unknown): Promise<T> {
  const baseUrl = process.env.BROWSER_SERVICE_URL!.trim().replace(/\/+$/, '');
  const token = process.env.BROWSER_SERVICE_TOKEN?.trim();
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Servico de navegador respondeu ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export type TargetedProspectingProgress = {
  runId: string;
  target: number;
  found: number;
  instagramFound: number;
  validated: number;
  discarded: number;
  pending: number;
};

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
  // Progresso de uma busca direcionada em andamento (tela de Prospeccao),
  // nulo quando nenhuma esta ativa - e o sinal que a UI usa pra mostrar o
  // modal de progresso.
  targetedRun: TargetedProspectingProgress | null;
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
let cdpBrowserAlive = false;
let cdpConnectionPromise: Promise<any> | null = null;
let currentWorkerLeadName: string | null = null;
let workerPreviewScreenshot: string | null = null;
const preparedDmPages = new Map<string, { page: Page; context: BrowserContext }>();

// --- Busca direcionada (tela de Prospeccao, "Quantidade de leads desejados") ---
// O navegador de fundo desta busca compete por CPU com o loop continuo
// (Iniciar IA) e com a janela visivel de "Visualizar perfil"/"Preparar DM".
// Com imagens/videos bloqueados e o perfil lido via JSON (sem renderizar a
// pagina), cada slot ficou bem mais leve - por isso da pra usar 3 em vez de 2.
const TARGETED_ENRICHMENT_CONCURRENCY = 3;
const TARGETED_MAX_DISCOVERY_ROUNDS = 6;
const TARGETED_OVERSHOOT = 2.5; // candidatos buscados por lead valido ainda faltando
const STALE_IN_PROGRESS_MS = 15 * 60 * 1000;
let activeTargetedRun: Promise<void> | null = null;
let targetedRunCancelled = false;
// Enquanto uma busca direcionada estiver rodando, o loop continuo
// (runWorkerLoop/runProspectingOnce) cede o navegador em vez de abrir o seu
// proprio - agora as duas coisas nao concorrem mais pelo mesmo Chrome. Nao
// mexe em workerState.status (o toggle "Iniciar/Pausar IA" continua
// mostrando ATIVO normalmente, so a atividade explica que esta cedendo a
// vez) e nao interrompe um ciclo que ja esteja no meio do processamento -
// so evita abrir um NOVO ciclo com navegador enquanto a flag estiver ligada.
let targetedRunActive = false;

// Processo de Chrome de fundo REAPROVEITADO entre chamadas (Buscar Leads,
// Visualizar perfil, Preparar DM, enriquecimento) em vez de abrir e fechar
// um processo novo a cada clique - o lancamento do Chromium sozinho (nao a
// navegacao ao Instagram) custa uns bons milissegundos/poucos segundos, e
// era pago de novo em toda chamada mesmo com o perfil ja visto minutos
// antes. Cada chamador ainda ganha sua propria BrowserContext isolada (com
// os cookies da sessao clonados) e a fecha sozinho ao terminar - so o
// processo do navegador em si fica vivo, ocioso, por um tempo antes de
// fechar sozinho.
let warmBackgroundBrowser: Browser | null = null;
let warmBackgroundBrowserAlive = false;
let warmBackgroundIdleTimer: NodeJS.Timeout | null = null;
const WARM_BACKGROUND_IDLE_MS = 5 * 60 * 1000;

function scheduleWarmBackgroundClose() {
  if (warmBackgroundIdleTimer) clearTimeout(warmBackgroundIdleTimer);
  warmBackgroundIdleTimer = setTimeout(() => {
    const browser = warmBackgroundBrowser;
    warmBackgroundBrowser = null;
    warmBackgroundBrowserAlive = false;
    if (browser?.isConnected()) browser.close().catch(() => undefined);
  }, WARM_BACKGROUND_IDLE_MS);
  // Node nao deve ficar de pe so por causa deste timer.
  warmBackgroundIdleTimer.unref();
}

async function getWarmBackgroundBrowser(): Promise<Browser> {
  if (warmBackgroundBrowser && warmBackgroundBrowserAlive) {
    scheduleWarmBackgroundClose();
    return warmBackgroundBrowser;
  }
  const chromium = await getChromium();
  const { executablePath, headless, extraArgs } = getChromeLaunchConfig();
  const browser = await chromium.launch(executablePath
    ? { headless, executablePath, args: extraArgs }
    : { headless, channel: 'chrome', args: extraArgs });
  warmBackgroundBrowser = browser;
  warmBackgroundBrowserAlive = true;
  browser.once('disconnected', () => {
    warmBackgroundBrowserAlive = false;
    if (warmBackgroundBrowser === browser) warmBackgroundBrowser = null;
  });
  scheduleWarmBackgroundClose();
  return browser;
}

// Fecha só a sessão (context) que uma chamada usou - NUNCA o processo
// compartilhado em si (browser.close() mataria o navegador pra todo mundo
// que estiver reaproveitando). Chamar isso no lugar do antigo
// `browser.close()` em cada callsite.
async function closeBackgroundSession(context: BrowserContext | undefined) {
  if (!context) return;
  await context.close().catch(() => undefined);
}

// Tipos de recurso que a prospeccao nunca usa (so le texto/JSON): bloquear
// corta a maior parte dos bytes de cada pagina do Instagram/DuckDuckGo e o
// custo de CPU de decodificar imagens/videos no Chromium de fundo.
const HEAVY_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

async function createBackgroundInstagramPage(opts: { lightweight?: boolean } = {}) {
  assertBrowserAutomationAvailable();
  const sessionBrowser = await getBrowserConnection();
  const sessionContext = await ensureBrowserContext(sessionBrowser);
  // So os cookies, NUNCA context.storageState() completo. storageState()
  // tambem coleta localStorage, o que exige avaliar JS em CADA aba aberta
  // na janela REAL/visivel do Chrome do usuario - e isso faz o Chrome
  // ativar/focar essa aba sozinho (foi a causa da aba do usuario "trocar
  // sozinha" pro Instagram toda vez que uma busca abria este navegador de
  // fundo). A sessao do Instagram e feita via cookie (sessionid,
  // csrftoken, ds_user_id etc. - o mesmo sessionid ja e o que
  // checkChromeConnection usa pra validar login), entao clonar so os
  // cookies preserva o login sem tocar em nenhuma pagina da janela real.
  const cookies = await sessionContext.cookies();
  const storageState = { cookies, origins: [] };
  const backgroundBrowser = await getWarmBackgroundBrowser();
  const context = await backgroundBrowser.newContext({
    storageState,
    viewport: { width: 1280, height: 900 },
  });
  // So em modo leve (prospeccao/enriquecimento). Preview e Preparar DM
  // precisam das imagens pra screenshot/interacao, entao nao usam isso.
  if (opts.lightweight) {
    await context.route('**/*', (route) => (
      HEAVY_RESOURCE_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue()
    ));
  }
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

  const executablePath = findChromeExecutable();
  // Diagnostico com 10 lancamentos isolados (scripts/_diag) mostrou que o
  // headless funciona normalmente nesta maquina, inclusive no perfil real
  // (C:\ChromeCRM) - a falha anterior nao era antivirus/politica bloqueando
  // headless, e sim dois processos disputando o mesmo perfil ao mesmo tempo
  // (o bug do loop de reconexao a cada 3s, ja corrigido, + uma janela do
  // Chrome aberta manualmente no mesmo perfil). Sem essa disputa, headless e
  // o padrao: nenhuma janela aparece pro usuario. CHROME_HEADLESS=false no
  // .env.local ainda funciona como valvula de escape manual se precisar
  // depurar visualmente algum dia.
  const headless = process.env.CHROME_HEADLESS !== 'false';
  const extraArgs = headless ? [] : ['--start-minimized', '--window-size=1024,768'];
  return {
    userDataDir,
    executablePath,
    headless,
    extraArgs,
  };
}

function findChromeExecutable() {
  const configuredPath = process.env.CHROME_EXECUTABLE_PATH?.trim();
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;

  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : [];

  return candidates.find((candidate) => fs.existsSync(candidate));
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

async function getBrowserConnection(opts: { passive?: boolean } = {}) {
  // IMPORTANTE: uma BrowserContext (retornada por launchPersistentContext) nao
  // possui o metodo isConnected() - so Browser (de connectOverCDP) tem. Usar
  // "cdpBrowser?.isConnected?.()" aqui sempre resultava em falsy pra conexoes
  // via perfil persistente, entao a cada poll (a cada 3s, no status do
  // dashboard) o codigo tentava abrir um Chrome NOVO no mesmo perfil ja em
  // uso - o que faz o Chrome (por ser instancia unica) so repassar os
  // argumentos pro processo ja aberto e abrir mais uma aba "about:blank",
  // enquanto o processo recem-lancado pelo Playwright morre sem nunca
  // completar o handshake (daí o erro "Target page, context or browser has
  // been closed" e as abas se multiplicando a cada poll). Rastreamos a
  // conexao viva via eventos em vez de isConnected().
  if (cdpBrowser && cdpBrowserAlive) return cdpBrowser;

  assertBrowserAutomationAvailable();
  const chromium = await getChromium();
  const preferredCdpUrl = process.env.CHROME_CDP_URL?.trim() || 'http://localhost:9222';

  // Modo passivo (usado pelo poll de status a cada poucos segundos no
  // dashboard): so tenta se ANEXAR a um Chrome que ja esteja com o CDP
  // aberto (handshake rapido, sem efeito colateral se nao houver nada
  // ouvindo na porta). NUNCA lanca um Chrome novo sozinho aqui - isso fica
  // reservado para uma acao explicita do usuario (Testar Conexao, Iniciar
  // IA, Buscar Instagram etc.), senao o simples fato de a pagina ficar
  // aberta reabriria o Chrome automaticamente sempre que o usuario fechasse
  // a janela manualmente. Antes, o modo passivo nem tentava conectar - so
  // retornava null sempre - o que fazia o badge do dashboard nunca sair de
  // "Desconectado" mesmo com o Chrome certo aberto, ate o usuario achar e
  // clicar em "Testar Conexao" em Configuracoes.
  if (opts.passive) {
    try {
      const browser = await chromium.connectOverCDP(preferredCdpUrl);
      cdpBrowser = browser;
      cdpBrowserAlive = true;
      browser.once('disconnected', () => {
        cdpBrowserAlive = false;
        if (cdpBrowser === browser) cdpBrowser = null;
      });
      return browser;
    } catch {
      return null;
    }
  }

  if (!cdpConnectionPromise) {
    cdpConnectionPromise = chromium.connectOverCDP(preferredCdpUrl)
      .then((browser) => {
        cdpBrowser = browser;
        cdpBrowserAlive = true;
        browser.once('disconnected', () => {
          cdpBrowserAlive = false;
          if (cdpBrowser === browser) cdpBrowser = null;
        });
        return browser;
      })
      .catch(async () => {
        if (preferredCdpUrl !== 'http://localhost:9222') throw new Error(`CDP unavailable at ${preferredCdpUrl}`);

        // O Chrome do atalho (Iniciar CRM.ps1) sobe EM PARALELO ao servidor -
        // na primeira tentativa de conexao (ex.: logo apos o boot, quando o
        // worker automatico ja tenta trabalhar), a porta CDP pode ainda nao
        // estar aberta. Sem essas novas tentativas, cairiamos direto no
        // fallback abaixo (lancar nosso PROPRIO Chrome no MESMO perfil), que
        // trava o perfil e impede o Chrome visivel de abrir o CDP dele pelo
        // resto da sessao - a automacao nunca mais fica pronta, mesmo
        // esperando bem mais tempo depois (reproduzido e confirmado numa
        // auditoria real). Da folga de ate 20s pro Chrome real terminar de
        // subir antes de decidir que ele nao vai aparecer.
        for (let tentativa = 0; tentativa < 10; tentativa++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try {
            const browser = await chromium.connectOverCDP(preferredCdpUrl);
            cdpBrowser = browser;
            cdpBrowserAlive = true;
            browser.once('disconnected', () => {
              cdpBrowserAlive = false;
              if (cdpBrowser === browser) cdpBrowser = null;
            });
            return browser;
          } catch {
            // Chrome ainda nao abriu o CDP - tenta de novo.
          }
        }

        const { userDataDir, executablePath, headless, extraArgs } = getChromeLaunchConfig();
        const browserContext = await chromium.launchPersistentContext(userDataDir, {
          headless,
          ...(executablePath ? { executablePath } : { channel: 'chrome' }),
          args: extraArgs,
        });
        cdpBrowser = browserContext as any;
        cdpBrowserAlive = true;
        browserContext.once('close', () => {
          cdpBrowserAlive = false;
          if (cdpBrowser === browserContext) cdpBrowser = null;
        });
        return browserContext;
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

export async function checkChromeConnection(opts: { passive?: boolean } = {}): Promise<{
  connected: boolean;
  username: string | null;
  error?: string;
}> {
  if (isBrowserServiceConfigured()) {
    if (opts.passive) return { connected: false, username: null };
    try {
      return await proxyToBrowserService<{ connected: boolean; username: string | null; error?: string }>('/check-connection', {});
    } catch (err: any) {
      return { connected: false, username: null, error: `Servico de navegador de Instagram indisponivel: ${err?.message ?? err}` };
    }
  }

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
    const browser = await getBrowserConnection(opts);
    if (!browser) {
      // Modo passivo sem conexao existente: nao mexe no estado salvo (nao
      // sobrescreve um erro/atividade relevante so por causa do poll), so
      // informa "nao conectado" pro badge do dashboard.
      return { connected: false, username: null };
    }
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
    const isGuardPage = instagramPage ? await hasInstagramGuardPage(instagramPage, pageText) : false;
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
    cdpBrowserAlive = false;
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
  // Passivo: o dashboard chama isso a cada 3s so pra mostrar um badge de
  // status. Nao pode abrir Chrome sozinho so por causa desse poll - senao
  // fechar a janela manualmente nunca "pega", ela volta em segundos.
  const [state, cdpCheck, counter] = await Promise.all([ensureWorkerState(), checkChromeConnection({ passive: true }), getCounter()]);

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
    targetedRun: state.progressRunId
      ? {
          runId: state.progressRunId,
          target: state.progressTarget ?? 0,
          found: state.progressFound ?? 0,
          instagramFound: state.progressInstagramFound ?? 0,
          validated: state.progressValidated ?? 0,
          discarded: state.progressDiscarded ?? 0,
          pending: state.progressPending ?? 0,
        }
      : null,
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

export async function pauseWorker(): Promise<{ success: boolean; message?: string; error?: string }> {
  if (isBrowserServiceConfigured()) {
    try {
      return await proxyToBrowserService<{ success: boolean; message?: string; error?: string }>('/worker/pause', {});
    } catch (err: any) {
      return { success: false, error: `Servico de navegador de Instagram indisponivel: ${err?.message ?? err}` };
    }
  }

  await setWorkerState({ status: 'PAUSADO', activity: 'Pausado manualmente', pausedReason: 'Pausa manual' });
  return { success: true, message: 'Automacao pausada.' };
}

// Chamado uma vez na subida do servidor (ver src/instrumentation.ts). O
// loop da automacao (runWorkerLoop) vive so na memoria do processo - todo
// reinicio do node.exe (crash, atualizacao, PC reiniciado) o mata de
// verdade, mas o ULTIMO status gravado no banco (ATIVO/PROCESSANDO/
// AGUARDANDO/etc.) continua lá, entao a tela do CRM mostrava a automacao
// como se estivesse rodando quando na pratica ela tinha parado - e so
// voltava a funcionar se alguem percebesse e clicasse em "Iniciar IA" nunca.
// Retomamos sozinhos aqui sempre que o ultimo estado gravado nao for
// "pausado explicitamente pelo usuario".
export async function resumeWorkerIfNeeded(): Promise<void> {
  if (isBrowserServiceConfigured()) return; // outro processo dedicado cuida do proprio ciclo de vida
  if (process.env.VERCEL === '1') return;
  try {
    const state = await ensureWorkerState();
    if (state.status !== 'PAUSADO') {
      console.log(`[WORKER] Retomando automacao apos reinicio do servidor (ultimo status: ${state.status}).`);
      await startWorker();
    }
  } catch (err: any) {
    console.error('[WORKER] Falha ao retomar automacao apos reinicio:', err?.message ?? err);
  }
}

export async function startWorker(): Promise<{ success: boolean; message?: string; error?: string }> {
  if (isBrowserServiceConfigured()) {
    try {
      return await proxyToBrowserService<{ success: boolean; message?: string; error?: string }>('/worker/start', {});
    } catch (err: any) {
      return { success: false, error: `Servico de navegador de Instagram indisponivel: ${err?.message ?? err}` };
    }
  }

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
    // Uma queda de internet/banco no meio do ciclo (ex.: consulta ao Turso
    // falhando) antes escapava daqui e matava o loop de vez - a automacao
    // so voltava reiniciando o servidor. Agora o ciclo que falhou e so
    // registrado e o loop tenta de novo depois do intervalo normal.
    try {
      const outcome = await runWorkerCycle(intervalMs);
      if (outcome === 'paused') return { success: true, message: 'Automacao pausada.' };
    } catch (err: any) {
      console.error('[WORKER] Ciclo falhou (tentando de novo no proximo intervalo):', err?.message ?? err);
      await setWorkerState({ lastError: `Ciclo falhou: ${err?.message ?? err}` }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

async function runWorkerCycle(intervalMs: number): Promise<'paused' | 'continue'> {
  const state = await ensureWorkerState();
  if (state.status === 'PAUSADO') return 'paused';

  const result = await runProspectingOnce();
  if (!result.success) {
    await setWorkerState({
      status: 'ERRO',
      activity: result.message ?? 'Falha na busca da IA',
      lastError: result.error ?? null,
    });
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    return 'continue';
  }

  const postSendState = await ensureWorkerState();
  if (postSendState.status === 'PAUSADO') return 'paused';

  // Enquanto uma busca direcionada estiver ativa, nao sobrescreve a
  // atividade dela com a mensagem generica de "proxima busca" - os dois
  // escrevem no mesmo campo (workerState.activity) e o modal de progresso
  // mostra esse texto ao vivo, entao isso piscava entre as duas mensagens.
  if (!targetedRunActive) {
    await setWorkerState({
      status: 'AGUARDANDO',
      activity: `Proxima busca em ${Math.round(intervalMs / 1000)} segundos`,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  return 'continue';
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

async function hasInstagramGuardPage(page: Page, content: string) {
  // Antes isto so casava trechos de texto genericos contra o corpo inteiro
  // da pagina - inclusive "Cadastre-se"/"Sign up", que fazem parte do
  // RODAPE do Instagram e aparecem em toda pagina, mesmo logado (feed
  // normal). Isso derrubava chromeConnected pra false pra sempre, mesmo com
  // sessao valida. Agora o sinal principal e a URL (login/challenge/consent
  // sao rotas exclusivas de fato do fluxo de bloqueio) e a presenca real de
  // um campo de senha no DOM; o casamento de texto fica so com frases
  // completas que nao aparecem fora de uma tela de bloqueio de verdade.
  const url = page.url();
  if (/\/(accounts\/login|accounts\/suspended|challenge|consent)(\/|$|\?)/i.test(url)) return true;
  try {
    const hasPasswordField = await page.locator('input[name="password"], input[type="password"]').count();
    if (hasPasswordField > 0) return true;
  } catch {}
  return [
    'Help Us Verify',
    'Log In to Instagram',
    'Entrar no Instagram',
    'temporariamente bloqueada',
    'temporarily locked',
    'captcha',
  ].some((needle) => content.toLowerCase().includes(needle.toLowerCase()));
}

// Substitui um `waitForTimeout` fixo por uma espera condicional: segue assim
// que a pagina do Instagram mostrar sinal real de conteudo carregado (header,
// article, ou qualquer role="button"), em vez de sempre esperar o tempo
// maximo. Nunca mais lento que o timeout antigo (mesmo teto), so mais rapido
// no caso comum em que a pagina carrega bem antes disso.
async function waitForInstagramContentReady(page: Page, maxMs: number) {
  await page.waitForSelector('header, article, [role="button"], input[type="password"]', { timeout: maxMs }).catch(() => undefined);
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

// Pool de N workers sobre uma fila compartilhada. Cada slot usa sempre a
// mesma Page do Playwright (navegacao concorrente na mesma Page nao e
// segura) - e assim que a concorrencia fica "controlada" sem abrir
// instancias extras de navegador (requisito 4).
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, slot: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async (_unused, slot) => {
      while (cursor < items.length) {
        if (targetedRunCancelled) return;
        const index = cursor++;
        await worker(items[index], slot);
      }
    }),
  );
}

type TargetedCounters = {
  target: number;
  found: number;
  instagramFound: number;
  validated: number;
  discarded: number;
  pending: number;
};

let targetedFlushAt = 0;

// setWorkerState grava no banco a cada chamada; o pool de enriquecimento
// chamaria isso demais. Coalescido pra no maximo 1x/segundo (exceto quando
// force=true), o que ainda fica bem abaixo do poll de 3s do cliente - a
// barra de progresso continua parecendo em tempo real.
async function flushTargetedProgress(runId: string, counters: TargetedCounters, activity: string | null, force = false) {
  if (!force && Date.now() - targetedFlushAt < 1000) return;
  targetedFlushAt = Date.now();
  // So atualiza o contador visivel na tela - nao e critico pro resultado da
  // busca em si. Uma falha passageira de rede aqui (ex.: blip de DNS) nao
  // deve abortar a busca inteira; so os pontos que realmente gravam/leem
  // dados do lead (dentro do loop principal) devem propagar erro de verdade.
  try {
    await setWorkerState({
      progressRunId: runId,
      progressTarget: counters.target,
      progressFound: counters.found,
      progressInstagramFound: counters.instagramFound,
      progressValidated: counters.validated,
      progressDiscarded: counters.discarded,
      progressPending: counters.pending,
      ...(activity ? { activity } : {}),
    });
  } catch (err: any) {
    console.warn('[TARGETED] Falha ao atualizar progresso (ignorada):', err?.message);
  }
}

// Portao de contato (requisito 3) + qualificacao por IA, compartilhado
// entre o loop continuo (runProspectingOnce) e a busca direcionada - assim
// a regra de descarte "sem contato" so existe implementada uma vez.
async function resolveLeadAfterEnrichment(
  lead: typeof leads.$inferSelect,
  minScore: number,
): Promise<'DISCARDED_NO_CONTACT' | 'QUALIFIED' | 'DISCARDED_SCORE'> {
  if (!PRE_CONTACT_STAGES.includes(lead.pipelineStage as (typeof PRE_CONTACT_STAGES)[number])) {
    // Ja saiu do estado "pre-contato" por outro caminho (ex.: usuario mexeu
    // manualmente) - nao mexe.
    return hasVerifiableContact(lead) ? 'QUALIFIED' : 'DISCARDED_NO_CONTACT';
  }

  if (!hasVerifiableContact(lead)) {
    await db.update(leads).set({
      pipelineStage: NO_CONTACT_STAGE,
      qualificationStatus: 'SEM_CONTATO',
      updatedAt: new Date(),
    }).where(and(eq(leads.id, lead.id), inArray(leads.pipelineStage, [...PRE_CONTACT_STAGES])));
    await db.insert(activities).values({
      id: crypto.randomUUID(),
      leadId: lead.id,
      type: 'PIPELINE_CHANGED',
      content: 'Descartado: nenhum contato verificável (Instagram válido ou telefone/WhatsApp).',
      metadata: JSON.stringify({ to: NO_CONTACT_STAGE, reason: 'NO_VERIFIABLE_CONTACT' }),
      createdAt: new Date(),
    });
    return 'DISCARDED_NO_CONTACT';
  }

  const analysis = await analyzeLeadAction(lead.id);
  if (analysis.success && typeof analysis.result?.score === 'number' && analysis.result.score >= minScore) {
    await db.update(leads).set({ pipelineStage: 'QUALIFICADO', updatedAt: new Date() })
      .where(and(eq(leads.id, lead.id), inArray(leads.pipelineStage, [...PRE_CONTACT_STAGES])));
    return 'QUALIFIED';
  }

  await db.update(leads).set({ pipelineStage: 'DESCARTADO', updatedAt: new Date() })
    .where(and(eq(leads.id, lead.id), inArray(leads.pipelineStage, [...PRE_CONTACT_STAGES])));
  return 'DISCARDED_SCORE';
}

export async function runProspectingOnce() {
  if (targetedRunActive) {
    // Uma busca direcionada (tela de Prospeccao) esta usando o Chrome agora
    // - cede a vez em vez de abrir um segundo navegador concorrente. O
    // proximo ciclo do loop (runWorkerLoop) tenta de novo normalmente; isso
    // nao conta como pausa (status continua o mesmo, so a atividade muda).
    await setWorkerState({ activity: 'Aguardando: busca direcionada em andamento na tela de Prospecção' });
    return { success: true, message: 'Aguardando busca direcionada terminar.' };
  }

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
  let backgroundWorkerContext: BrowserContext | undefined;
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
        const background = await createBackgroundInstagramPage({ lightweight: true });
        backgroundWorkerContext = background.context;
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
        const background = await createBackgroundInstagramPage({ lightweight: true });
        backgroundWorkerContext = background.context;
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
      // Mas so quando ainda nao ha um resultado de cache (enrichment_status
      // 'DONE') - sem isso, um lead que ja tinha sido validado com sucesso
      // podia ser reaberto/re-raspado do zero em runs seguintes deste loop,
      // desperdicando tempo e reforcando a concorrencia pelo Chrome.
      if (enrichmentPage && lead.enrichmentStatus !== 'DONE') {
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
        await enrichmentPage.waitForTimeout(300);
      }

      // Re-le o lead: o enriquecimento acima pode ter gravado
      // instagramUsername/profileAccepted/phone que o portao de contato
      // (requisito 3) e a analise de IA precisam enxergar.
      const freshLead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0] ?? lead;
      if (freshLead.profileAccepted === true) {
        // Mesmo pre-aquecimento do cache de preview que a busca direcionada
        // faz - assim "Preparar DM" mostra a imagem do perfil na hora,
        // mesmo quando o lead veio do loop continuo (Iniciar IA) em vez da
        // busca sob demanda.
        await previewInstagramProfileViaBrowser(leadId).catch((err: any) => {
          console.warn('[WORKER] Falha ao pre-aquecer preview do Instagram:', leadId, err?.message);
        });
      }
      await setWorkerState({ activity: `Analisando ${freshLead.businessName}` });
      const outcome = await resolveLeadAfterEnrichment(freshLead, minScore);
      if (outcome === 'QUALIFIED') {
        qualified++;
        await setWorkerState({ activity: `Lead aprovado — ${freshLead.businessName}` });
      } else if (outcome === 'DISCARDED_NO_CONTACT') {
        await setWorkerState({ activity: `${freshLead.businessName} descartado — sem contato verificável` });
      } else {
        await setWorkerState({ activity: `${freshLead.businessName} descartado após análise` });
      }
    }

    if (instagramPage) await instagramPage.close();
    if (enrichmentPage && enrichmentPage !== instagramPage) await enrichmentPage.close();
    await closeBackgroundSession(backgroundWorkerContext);
    await releaseBrowserConnection(browser);
    await setWorkerState({ status: 'AGUARDANDO', activity: `Execucao concluida: ${discovered} encontrados, ${qualified} qualificados` });
    currentWorkerLeadName = null;
    return { success: true, message: `Execucao concluida: ${discovered} encontrados, ${qualified} qualificados.` };
  } catch (err: any) {
    await closeBackgroundSession(backgroundWorkerContext);
    await releaseBrowserConnection(browser);
    const error = `Erro no Browser Worker: ${err?.message ?? 'falha desconhecida'}`;
    await setWorkerState({ status: 'ERRO', activity: 'Erro durante execucao', lastError: error });
    console.error('[ERROR]', error);
    return { success: false, error, message: error };
  }
}

// --- Busca direcionada: "Quantidade de leads desejados" (tela de Prospeccao) ---
//
// Diferente de runProspectingOnce (loop continuo, sem meta, disparado pelo
// toggle Iniciar/Pausar IA), esta funcao busca ate atingir uma quantidade
// especifica de leads VALIDOS (com contato verificavel), reaproveitando
// primeiro o que ja existe no banco (requisito 2/5), processando com
// concorrencia controlada (requisito 4) e nunca bloqueando quem chamou -
// startTargetedProspecting dispara e retorna na hora.

export async function startTargetedProspecting(desiredCount: number): Promise<{ success: boolean; runId?: string; message?: string; error?: string }> {
  if (isBrowserServiceConfigured()) {
    try {
      return await proxyToBrowserService('/prospecting/targeted', { desiredCount });
    } catch (err: any) {
      return { success: false, error: `Servico de navegador indisponivel: ${err?.message ?? err}` };
    }
  }

  const target = Math.min(Math.max(Math.trunc(desiredCount) || 0, 1), 200);
  if (activeTargetedRun) {
    return { success: false, error: 'Já existe uma busca de leads em andamento.' };
  }

  const s = await getSettings();
  if (!s) {
    return { success: false, error: 'Configure cidades, segmentos ou termos de pesquisa antes de buscar.' };
  }

  // Persiste a ultima quantidade pedida - reaproveita a coluna
  // settings.dailyQueueSize, que ate aqui nao era lida por ninguem, como
  // valor padrao pra pre-preencher o campo na proxima visita a tela.
  await db.update(settings).set({ dailyQueueSize: target }).where(eq(settings.id, s.id));

  const runId = crypto.randomUUID();
  targetedRunCancelled = false;
  await flushTargetedProgress(
    runId,
    { target, found: 0, instagramFound: 0, validated: 0, discarded: 0, pending: 0 },
    `Busca iniciada: 0/${target} leads válidos`,
    true,
  );

  // Fire-and-forget: quem chamou nao espera o run terminar (requisito 4).
  activeTargetedRun = runTargetedProspecting(runId, target, s)
    .catch(async (err: any) => {
      console.error('[TARGETED] Erro na busca direcionada:', err?.message ?? err);
      await setWorkerState({ lastError: `Erro na busca direcionada: ${err?.message ?? err}` });
    })
    .finally(async () => {
      activeTargetedRun = null;
      await setWorkerState({ progressRunId: null });
    });

  return { success: true, runId, message: `Buscando ${target} leads com contato verificável...` };
}

export async function cancelTargetedProspecting(): Promise<{ success: boolean }> {
  targetedRunCancelled = true;
  return { success: true };
}

async function runTargetedProspecting(runId: string, target: number, s: typeof settings.$inferSelect): Promise<void> {
  const counters: TargetedCounters = { target, found: 0, instagramFound: 0, validated: 0, discarded: 0, pending: 0 };
  const minScore = s.minScoreForQueue ?? 0;
  // Cede o Chrome pro loop continuo nao abrir seu proprio navegador de fundo
  // enquanto esta busca estiver ativa (reduz a concorrencia que deixava o
  // carregamento do perfil do Instagram lento). Sempre desligada no finally
  // mais abaixo, mesmo em erro/cancelamento.
  targetedRunActive = true;

  let backgroundContext: BrowserContext | undefined;
  let pages: Page[] = [];
  // Antes isso chamava checkChromeConnection() primeiro, que le o texto da
  // aba do Instagram que estiver aberta na janela REAL/visivel do Chrome
  // (a mesma que o usuario usa pra "Visualizar perfil"/"Preparar DM") -
  // suspeita forte de ser o motivo da aba do usuario "trocar sozinha" ao
  // clicar em Buscar leads. createBackgroundInstagramPage() ja abre um
  // Chromium HEADLESS totalmente a parte (so clona os cookies de sessao via
  // storageState, sem navegar nem ler nada na janela visivel), entao basta
  // tentar abri-lo direto - se nao houver sessao/CDP disponivel, cai no
  // catch e segue so com telefone/WhatsApp.
  try {
    const background = await createBackgroundInstagramPage({ lightweight: true });
    backgroundContext = background.context;
    pages = [background.page];
    for (let i = 1; i < TARGETED_ENRICHMENT_CONCURRENCY; i++) {
      pages.push(await background.context.newPage());
    }
  } catch (err: any) {
    console.warn('[TARGETED] Nao foi possivel abrir o Chrome para enriquecimento; seguindo so com telefone/WhatsApp:', err?.message);
  }

  try {
    let rounds = 0;
    while (counters.validated < target && rounds < TARGETED_MAX_DISCOVERY_ROUNDS && !targetedRunCancelled) {
      rounds++;
      let pool: string[] = [];

      if (rounds === 1) {
        // Requisito 2/5: reaproveita candidatos ja existentes e pendentes
        // de validacao antes de pesquisar de novo. Linhas com
        // enrichment_status='DONE' sao hits de cache puro - vao direto pro
        // portao de contato dentro do pool, sem tocar o navegador.
        const staleThreshold = new Date(Date.now() - STALE_IN_PROGRESS_MS);
        const reusable = await db.select({ id: leads.id }).from(leads).where(and(
          ne(leads.source, 'TEST_FIXTURE'),
          eq(leads.doNotContact, false),
          inArray(leads.pipelineStage, [...PRE_CONTACT_STAGES]),
          or(
            isNull(leads.enrichmentStatus),
            inArray(leads.enrichmentStatus, ['PENDING', 'DONE']),
            and(
              eq(leads.enrichmentStatus, 'IN_PROGRESS'),
              or(isNull(leads.enrichmentAttemptedAt), lt(leads.enrichmentAttemptedAt, staleThreshold)),
            ),
          ),
        )).orderBy(desc(leads.createdAt)).limit(target * 4);
        pool = reusable.map((row) => row.id);
      }

      if (pool.length === 0) {
        const remaining = Math.max(target - counters.validated, 1);
        const batch = Math.min(Math.max(Math.ceil(remaining * TARGETED_OVERSHOOT), 5), 60);
        await flushTargetedProgress(runId, counters, `Buscando mais candidatos (${batch})...`, true);
        const res = await discoverGeoapifyPlaces({ ...s, maxProfilesPerRun: batch });
        counters.found += res.created;
        pool = res.leadIds;
        if (res.errors.length > 0) await setWorkerState({ lastError: res.errors.join(' | ') });
        if (res.created === 0) break; // Geoapify esgotado para os termos configurados
      } else {
        counters.found += pool.length;
      }

      counters.pending = pool.length;
      await flushTargetedProgress(runId, counters, `Prospectando: ${counters.validated}/${target}`, true);

      await runWithConcurrency(pool, pages.length || 1, async (leadId, slot) => {
        if (counters.validated >= target || targetedRunCancelled) return;
        // Uma falha isolada neste lead (ex.: blip de rede numa consulta ao
        // banco) nao pode derrubar a busca inteira - so pula esse lead e
        // segue pros proximos. O timeout de 20s no cliente do banco
        // (src/db/index.ts) garante que isso falha rapido em vez de travar.
        try {
          const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
          if (!lead) return;

          // Cache hit (requisito 5): ja enriquecido antes, mostra na hora sem
          // busca externa nova.
          if (lead.enrichmentStatus !== 'DONE' && pages[slot]) {
            await db.update(leads).set({ enrichmentStatus: 'IN_PROGRESS', enrichmentAttemptedAt: new Date() }).where(eq(leads.id, leadId));
            try {
              await enrichLeadWithInstagram(pages[slot], lead);
            } catch (err: any) {
              console.warn('[TARGETED] Enriquecimento falhou:', leadId, err?.message);
            }
          }

          const fresh = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0] ?? lead;
          if (fresh.profileAccepted === true) {
            counters.instagramFound++;
            // Pre-aquece o cache de screenshot do perfil (o mesmo que
            // "Visualizar perfil" e "Preparar DM" leem) enquanto a busca
            // ainda esta rodando em segundo plano - assim, quando o usuario
            // clicar em "Preparar DM" depois, a imagem do perfil aparece na
            // hora em vez de um espaco vazio girando ate a navegacao real
            // terminar. Erro aqui nao pode atrapalhar a busca em si.
            // Enfileirado em segundo plano (um por vez) em vez de aguardado:
            // antes cada lead pagava uma navegacao extra completa ao perfil so
            // pra tirar essa foto, antes de a busca seguir pro proximo.
            queuePreviewWarmup(leadId);
          }

          const outcome = await resolveLeadAfterEnrichment(fresh, minScore);
          if (outcome === 'DISCARDED_NO_CONTACT') counters.discarded++;
          else counters.validated++;

          counters.pending = Math.max(counters.pending - 1, 0);
          await flushTargetedProgress(runId, counters, `Prospectando: ${counters.validated}/${target} · ${fresh.businessName}`);
        } catch (err: any) {
          console.warn('[TARGETED] Falha ao processar lead (pulando):', leadId, err?.message);
          counters.pending = Math.max(counters.pending - 1, 0);
        }
      });
    }

    await flushTargetedProgress(
      runId,
      counters,
      `Busca concluída: ${counters.validated}/${target} leads válidos, ${counters.discarded} descartados sem contato`,
      true,
    );
  } finally {
    for (const page of pages) {
      if (!page.isClosed()) await page.close().catch(() => undefined);
    }
    await closeBackgroundSession(backgroundContext);
    targetedRunActive = false;
  }
}

export async function enrichLeadViaBrowser(leadId: string): Promise<{ success: boolean; error?: string; username?: string; followers?: number | null; method?: string | null }> {
  if (isBrowserServiceConfigured()) {
    try {
      return await proxyToBrowserService<{ success: boolean; error?: string; username?: string; followers?: number | null; method?: string | null }>('/enrich-lead', { leadId });
    } catch (err: any) {
      return { success: false, error: `Servico de navegador de Instagram indisponivel: ${err?.message ?? err}` };
    }
  }

  let lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
  if (!lead) return { success: false, error: 'Lead nao encontrado.' };

  // Se uma busca direcionada ativa JA esta processando este lead agora
  // mesmo (enrichment_status='IN_PROGRESS', gravado bem recentemente),
  // disparar aqui um enriquecimento MANUAL duplicado so faz os dois
  // competirem pelo mesmo navegador de fundo ao mesmo tempo - deixando os
  // DOIS mais lentos (era exatamente o que estava acontecendo quando o
  // usuario clicava "Preparar DM" num lead que a busca automatica ainda
  // nao tinha chegado). Como essa busca processa um lead de cada vez
  // (concorrencia 1), da uma folga curta pra ela terminar ESTE lead
  // especifico - custa poucos segundos, mas evita reabrir o Instagram do
  // zero pro mesmo lead duas vezes ao mesmo tempo.
  if (targetedRunActive && lead.enrichmentStatus === 'IN_PROGRESS' && lead.enrichmentAttemptedAt) {
    const attemptedMsAgo = Date.now() - new Date(lead.enrichmentAttemptedAt).getTime();
    if (attemptedMsAgo < 2 * 60 * 1000) {
      for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const refreshed = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
        if (refreshed && refreshed.enrichmentStatus !== 'IN_PROGRESS') {
          lead = refreshed;
          break;
        }
      }
    }
  }

  if (sanitizeInstagramUsername(lead.instagramUsername)) {
    return {
      success: true,
      username: sanitizeInstagramUsername(lead.instagramUsername) ?? undefined,
      followers: lead.followers,
      method: 'ja_encontrado_pela_busca_ativa',
    };
  }

  let context: BrowserContext | undefined;
  try {
    try {
      const background = await createBackgroundInstagramPage({ lightweight: true });
      context = background.context;
      // A desambiguacao via IA (quando ha varios perfis de Instagram
      // candidatos parecidos) continua habilitada aqui - e necessaria pra
      // descobrir qual e o perfil certo (a IA do CRM e usada so na busca e
      // qualificacao de leads, nunca pra redigir mensagens).
      const result = await enrichLeadWithInstagram(background.page, lead);
      await closeBackgroundSession(context);

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
      await closeBackgroundSession(context);
      return { success: false, error: `Nao foi possivel conectar ao navegador: ${err?.message ?? String(err)}` };
    }
  } catch (err: any) {
    await closeBackgroundSession(context);
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

// "Visualizar perfil" abria um Chromium de fundo inteiro (processo novo +
// navegacao + 2.5s de espera + screenshot) a cada clique, mesmo pro MESMO
// lead visto minutos antes - pesado e lento (e o usuario clicando de novo no
// mesmo lead pagava o preco todo de novo). Cacheia por username com um TTL
// curto: perfil do Instagram nao muda a cada poucos minutos, entao reusar a
// ultima screenshot evita reabrir o navegador sem exibir nada desatualizado
// na pratica.
const instagramPreviewCache = new Map<string, { screenshot: string; expiresAt: number }>();
const PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const PREVIEW_CACHE_MAX_SIZE = 50;

function getCachedPreview(username: string) {
  const entry = instagramPreviewCache.get(username);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    instagramPreviewCache.delete(username);
    return null;
  }
  return entry.screenshot;
}

// Fila serial de pre-aquecimento de preview: nunca mais de uma navegacao de
// preview ao mesmo tempo, pra nao competir com o enriquecimento da busca.
let previewWarmupChain: Promise<unknown> = Promise.resolve();
function queuePreviewWarmup(leadId: string) {
  previewWarmupChain = previewWarmupChain
    .then(() => previewInstagramProfileViaBrowser(leadId))
    .catch((err) => {
      console.warn('[TARGETED] Falha ao pre-aquecer preview do Instagram:', leadId, err?.message);
    });
}

function setCachedPreview(username: string, screenshot: string) {
  if (!instagramPreviewCache.has(username) && instagramPreviewCache.size >= PREVIEW_CACHE_MAX_SIZE) {
    const oldestKey = instagramPreviewCache.keys().next().value;
    if (oldestKey) instagramPreviewCache.delete(oldestKey);
  }
  instagramPreviewCache.set(username, { screenshot, expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS });
}

export async function previewInstagramProfileViaBrowser(leadId: string, opts: { forceRefresh?: boolean } = {}): Promise<{ success: boolean; error?: string; screenshot?: string; cached?: boolean }> {
  if (isBrowserServiceConfigured()) {
    try {
      return await proxyToBrowserService<{ success: boolean; error?: string; screenshot?: string }>('/preview-profile', { leadId });
    } catch (err: any) {
      return { success: false, error: `Servico de navegador de Instagram indisponivel: ${err?.message ?? err}` };
    }
  }

  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0];
  const username = sanitizeInstagramUsername(lead?.instagramUsername);
  if (!username) return { success: false, error: 'Este lead não possui Instagram confirmado ou o valor está inválido.' };

  if (!opts.forceRefresh) {
    const cached = getCachedPreview(username);
    if (cached) return { success: true, screenshot: cached, cached: true };
  }

  let backgroundContext: BrowserContext | undefined;
  try {
    const background = await createBackgroundInstagramPage();
    backgroundContext = background.context;
    await background.page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForInstagramContentReady(background.page, 2500);
    const bodyText = await background.page.locator('body').innerText().catch(() => '');
    if (await hasInstagramGuardPage(background.page, bodyText)) return { success: false, error: 'O Instagram solicitou login ou verificação da sessão.' };
    const screenshot = await background.page.screenshot({ type: 'jpeg', quality: 50, fullPage: false });
    const dataUrl = `data:image/jpeg;base64,${screenshot.toString('base64')}`;
    setCachedPreview(username, dataUrl);
    return { success: true, screenshot: dataUrl };
  } catch (err: any) {
    return { success: false, error: `Não foi possível visualizar o perfil: ${err?.message ?? 'falha desconhecida'}` };
  } finally {
    await closeBackgroundSession(backgroundContext);
  }
}

const DM_CHAT_INPUT_SELECTOR = 'div[contenteditable="true"], p[contenteditable="true"], textarea, [role="textbox"]';

export async function sendFirstDmViaBrowser(leadId: string, requestedMessage?: string): Promise<DmPreparationResult> {
  if (isBrowserServiceConfigured()) {
    try {
      return await proxyToBrowserService<DmPreparationResult>('/send-first-dm', { leadId, requestedMessage });
    } catch (err: any) {
      return { success: false, error: `Servico de navegador de Instagram indisponivel: ${err?.message ?? err}` };
    }
  }

  // Tudo que so LE o banco (remoto) sai em paralelo - antes eram 5+ idas e
  // voltas em serie antes de sequer tocar o navegador. A conexao ao Chrome
  // (CDP) e o lancamento do Chromium de fundo tambem ja comecam aqui, em
  // paralelo, em vez de esperar as checagens terminarem.
  const cdpCheckPromise = checkChromeConnection();
  if (process.env.VERCEL !== '1') void getWarmBackgroundBrowser().catch(() => undefined);
  const [s, counter, leadRows, lastGeneratedRows] = await Promise.all([
    getSettings(),
    getCounter(),
    db.select().from(leads).where(eq(leads.id, leadId)).limit(1),
    requestedMessage?.trim()
      ? Promise.resolve([] as Array<typeof activities.$inferSelect>)
      : db
        .select()
        .from(activities)
        .where(sql`${activities.leadId} = ${leadId} AND ${activities.type} = 'MESSAGE_GENERATED'`)
        .orderBy(desc(activities.createdAt))
        .limit(1),
  ]);
  const dryRun = s?.prospectionDryRun ?? process.env.PROSPECTION_DRY_RUN !== 'false';

  if (counter.count >= counter.limit) {
    const error = `Limite diario de envio (${counter.limit} DMs) atingido para hoje.`;
    // Antes isso pausava o worker inteiro (status: 'PAUSADO'), o que parava
    // a prospeccao/descoberta junto com o envio de DMs - acoplamento
    // indevido, ja que agora a busca de leads e orientada por quantidade e
    // independente do limite diario de envio. So o envio para.
    await setWorkerState({ activity: 'Limite diario de DMs atingido', lastError: error, pausedReason: 'Limite diario' });
    return { success: false, error };
  }

  let lead = leadRows[0];
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

  const cdpCheck = await cdpCheckPromise;
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

  // "Preparar DM" (fluxo manual da Fila de Prospeccao) so deve abrir a
  // conversa e deixar o campo pronto pra digitacao. O texto e escrito pelo
  // usuario na Fila (ou parte do modelo fixo, sem IA) e so chega de fato na
  // conversa do Instagram na confirmacao (confirmPreparedDmViaBrowser).
  let messageToSend = requestedMessage?.trim() ?? '';
  if (!messageToSend && lastGeneratedRows[0]?.content) messageToSend = lastGeneratedRows[0].content;

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

  let context: BrowserContext | undefined;

  try {
    // So status visivel no painel - nao segura a abertura da conversa.
    void setWorkerState({ status: 'PROCESSANDO', activity: `Enviando DM para @${lead.instagramUsername}` }).catch(() => undefined);
    const background = await createBackgroundInstagramPage();
    context = background.context;
    let page = background.page;
    const cleanUsername = sanitizeInstagramUsername(lead.instagramUsername) ?? '';
    if (!cleanUsername) {
      await closeBackgroundSession(context);
      return { success: false, error: 'Usuario do Instagram inválido para preparar a conversa.' };
    }

    await page.goto(`https://www.instagram.com/${cleanUsername}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const messageButtonSelectors = [
      'button:has-text("Enviar mensagem")',
      'button:has-text("Mensagem")',
      'button:has-text("Message")',
      'div[role="button"]:has-text("Enviar mensagem")',
      'div[role="button"]:has-text("Mensagem")',
      'div[role="button"]:has-text("Message")',
    ];

    // Espera especificamente pelo botao de mensagem (ou pelo menos pelo botao
    // "Seguir", que renderiza junto dele na mesma area de acoes do perfil) -
    // waitForInstagramContentReady() generico (header/article/[role=button])
    // resolvia cedo demais aqui: a pagina ja tem VARIOS [role="button"]
    // genericos (ex.: "Opções") que aparecem antes do botao de mensagem
    // especifico, entao o codigo tentava clicar antes dele existir e
    // reportava "nao encontrado" com contas legitimas e publicas. Espera so
    // pelo sinal que realmente importa aqui.
    await page.waitForSelector(
      [...messageButtonSelectors, 'button:has-text("Seguir")', 'div[role="button"]:has-text("Seguir")'].join(', '),
      { timeout: 6000 },
    ).catch(() => undefined);

    const pageContent = await page.locator('body').innerText();
    if (await hasInstagramGuardPage(page, pageContent)) {
      const error = `Instagram solicitou verificação/login em ${cleanUsername}. Confirme a sessão do Instagram e tente novamente.`;
      await setWorkerState({ status: 'PAUSADO', activity: error, lastError: error, pausedReason: 'Protecao do Instagram' });
      await closeBackgroundSession(context);
      return { success: false, error };
    }

    let clicked = false;
    for (const selector of messageButtonSelectors) {
      const btn = page.locator(selector).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        const pagesBeforeClick = new Set(context.pages());
        await btn.click();
        // Segue assim que a conversa abrir (campo de digitacao visivel na
        // mesma aba, ou uma aba nova) em vez de sempre esperar 1,5s fixos.
        await Promise.race([
          context.waitForEvent('page', { timeout: 4000 }),
          page.waitForSelector(DM_CHAT_INPUT_SELECTOR, { timeout: 4000 }),
        ]).catch(() => undefined);
        const openedPage = context.pages().find((candidate) => !pagesBeforeClick.has(candidate) && !candidate.isClosed());
        if (openedPage) page = openedPage;
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      await closeBackgroundSession(context);
      const error = `Botao de mensagem nao encontrado para @${cleanUsername}.`;
      await setWorkerState({ status: 'ERRO', activity: error, lastError: error });
      return { success: false, error };
    }

    if (page.isClosed()) {
      const replacement = context.pages().find((candidate) => !candidate.isClosed() && candidate.url().includes('instagram.com'));
      if (!replacement) throw new Error('A conversa do Instagram foi fechada antes de ser carregada.');
      page = replacement;
    }
    await page.waitForSelector(DM_CHAT_INPUT_SELECTOR, { timeout: 2000 }).catch(() => undefined);
    const chatInputs = page.locator(DM_CHAT_INPUT_SELECTOR);
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
      await closeBackgroundSession(context);
      const messagingBlocked = /n[aã]o (?:pode|permite).*mensagem|doesn.?t allow.*message|can.?t message|unable to message/i.test(chatPageText);
      const error = messagingBlocked
        ? `@${cleanUsername} não aceita mensagens de contas que não segue. Pule este lead ou tente outro canal.`
        : `Campo de digitação do chat não encontrado para @${cleanUsername}.`;
      await setWorkerState({ status: 'ERRO', activity: error, lastError: error });
      return { success: false, error };
    }

    await chatInput.focus();
    await chatInput.fill(messageToSend);
    await page.waitForTimeout(250);
    const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 45, fullPage: false });
    preparedDmPages.set(leadId, { page, context });
    void setWorkerState({ status: 'AGUARDANDO', activity: `DM preparada para @${cleanUsername}; aguardando confirmação`, lastError: null }).catch(() => undefined);
    return {
      success: true,
      prepared: true,
      message: messageToSend,
      screenshot: `data:image/jpeg;base64,${screenshotBuffer.toString('base64')}`,
    };
  } catch (err: any) {
    await closeBackgroundSession(context);
    const error = `Erro durante execucao do Playwright: ${err?.message ?? 'falha desconhecida'}`;
    await setWorkerState({ status: 'ERRO', activity: 'Falha no envio', lastError: error });
    return { success: false, error };
  }
}

export async function confirmPreparedDmViaBrowser(leadId: string, requestedMessage: string): Promise<{ success: boolean; error?: string; dryRun?: boolean }> {
  if (isBrowserServiceConfigured()) {
    try {
      return await proxyToBrowserService<{ success: boolean; error?: string; dryRun?: boolean }>('/confirm-dm', { leadId, requestedMessage });
    } catch (err: any) {
      return { success: false, error: `Servico de navegador de Instagram indisponivel: ${err?.message ?? err}` };
    }
  }

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
    await closeBackgroundSession(prepared?.context);

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
    await scheduleFollowUpAfterContact(leadId, now);
    await incrementCounter();
    await setWorkerState({ status: 'ATIVO', activity: `DM enviada para @${lead.instagramUsername}`, lastError: null });
    return { success: true };
  } catch (err: any) {
    const error = `Erro ao confirmar a DM: ${err?.message ?? 'falha desconhecida'}`;
    await setWorkerState({ status: 'ERRO', activity: 'Falha ao confirmar envio', lastError: error });
    return { success: false, error };
  }
}

export async function cancelPreparedDmViaBrowser(leadId: string): Promise<{ success: boolean; error?: string }> {
  if (isBrowserServiceConfigured()) {
    try {
      return await proxyToBrowserService<{ success: boolean; error?: string }>('/cancel-dm', { leadId });
    } catch (err: any) {
      return { success: false, error: `Servico de navegador de Instagram indisponivel: ${err?.message ?? err}` };
    }
  }

  const prepared = preparedDmPages.get(leadId);
  preparedDmPages.delete(leadId);
  await closeBackgroundSession(prepared?.context);
  return { success: true };
}
