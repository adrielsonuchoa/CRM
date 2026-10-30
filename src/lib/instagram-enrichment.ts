import type { Page } from 'playwright';
import { db } from '@/db';
import { activities, leads } from '@/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { findInstagramOnWebsite } from '@/lib/prospecting-sources';
import { CACHE_TTL, cached } from '@/lib/cache';
import { disambiguateInstagramCandidates, suggestInstagramUsernamesWithAI } from '@/app/actions/ai';


export type InstagramProfileData = {
  username: string;
  displayName: string | null;
  followers: number | null;
  bio: string | null;
  profileText: string;
  postsCount: number | null;
  isPrivate: boolean;
  isActive: boolean;
  category: string | null;
  website?: string | null;
  phone?: string | null;
};

function normalizeName(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCount(value: string | null | undefined): number | null {
  if (!value) return null;
  const cleaned = value.trim().toLowerCase().replace(/\s+/g, ' ').replace(',', '.');
  const match = cleaned.match(/^([\d.]+)\s*(mil|k|m)?/);
  if (!match) return null;
  const base = parseFloat(match[1]);
  if (Number.isNaN(base)) return null;
  if (match[2] === 'mil' || match[2] === 'k') return Math.round(base * 1000);
  if (match[2] === 'm') return Math.round(base * 1000000);
  return Math.round(base);
}

export function guessInstagramUsernames(businessName: string): string[] {
  const normalized = businessName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const rawWords = normalized
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !['restaurante', 'restaurantes', 'pizzaria', 'pizzarias', 'bar', 'cafe', 'cafeteria', 'lanchonete', 'delivery', 'maceio', 'al', 'mcz', 'hamburgueria', 'hamburguerias', 'burger', 'burguer'].includes(word));

  const words = rawWords.filter((word) => word.length >= 2);
  const compact = normalizeName(businessName).replace(/[^a-z0-9]/g, '').slice(0, 30);
  const compactNoStopwords = normalizeName(businessName)
    .replace(/[^a-z0-9]/g, '')
    .replace(/(restaurante|restaurantes|pizzaria|pizzarias|bar|cafe|cafeteria|lanchonete|delivery|hamburgueria|hamburguerias|maceio|alagoas|mcz)/g, '')
    .slice(0, 30);

  const guesses = new Set<string>();

  if (words[0]) guesses.add(words[0]);
  if (words.length >= 2) {
    guesses.add(words[0] + words[1]);
    guesses.add(`${words[0]}_${words[1]}`);
    guesses.add(words.join(''));
    guesses.add(words.slice(0, 2).join('_'));
  }
  if (words.length >= 3) {
    guesses.add(words.slice(0, 3).join(''));
    guesses.add(words.slice(0, 3).join('_'));
  }

  const fullNoSpaces = normalized.replace(/[^a-z0-9]/g, '');
  if (fullNoSpaces.length >= 4) {
    guesses.add(fullNoSpaces.slice(0, 30));
  }

  if (compact.length >= 3) guesses.add(compact);
  if (compactNoStopwords.length >= 3) guesses.add(compactNoStopwords);

  if (words.length > 0) {
    const joined = words.join('');
    if (joined.length >= 4) guesses.add(joined.slice(0, 30));
  }

  const ordered = Array.from(guesses)
    .filter((value) => value.length >= 3 && /^[a-z0-9._]+$/.test(value))
    .sort((a, b) => {
      const aLen = a.length;
      const bLen = b.length;
      if (aLen !== bLen) return bLen - aLen;
      return a.localeCompare(b);
    });

  return ordered;
}

// --- Leitura do perfil via JSON (endpoint web do proprio Instagram) --------
// Renderizar a pagina do perfil custa varios segundos (SPA + imagens); o
// mesmo endpoint que o site usa internamente devolve os dados em ~300ms, sem
// renderizar nada. Usa os cookies da sessao do contexto do Playwright. Se o
// Instagram recusar (429/401/redirect pro login), entra em pausa por alguns
// minutos e o fluxo cai de volta na leitura pela pagina (comportamento antigo).
const IG_WEB_APP_ID = '936619743392459';
const IG_API_BACKOFF_MS = 5 * 60 * 1000;
let igApiBackoffUntil = 0;
let cachedUserAgent: string | null = null;

async function getBrowserUserAgent(page: Page) {
  if (cachedUserAgent) return cachedUserAgent;
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
  cachedUserAgent = ua ? ua.replace('HeadlessChrome', 'Chrome') : null;
  return cachedUserAgent;
}

function cleanInstagramHandle(username: string) {
  const raw = String(username).trim();
  const withoutAt = raw.replace(/^@/, '');
  const withoutBaseUrl = withoutAt
    .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '')
    .replace(/^https?:\/\/(?:www\.)?instagram\.com$/i, '');
  const normalized = withoutBaseUrl.split(/[/?#]/)[0].trim();
  return normalized && /^[a-zA-Z0-9._]+$/.test(normalized) ? normalized.toLowerCase() : null;
}

/**
 * undefined = API indisponivel (usar a pagina); null = perfil nao existe.
 */
export async function fetchInstagramProfileViaApi(page: Page, username: string): Promise<InstagramProfileData | null | undefined> {
  const cleanUsername = cleanInstagramHandle(username);
  if (!cleanUsername) return null;
  if (Date.now() < igApiBackoffUntil) return undefined;

  try {
    const userAgent = await getBrowserUserAgent(page);
    const response = await page.context().request.get(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(cleanUsername)}`,
      {
        headers: {
          'x-ig-app-id': IG_WEB_APP_ID,
          'x-requested-with': 'XMLHttpRequest',
          referer: `https://www.instagram.com/${cleanUsername}/`,
          ...(userAgent ? { 'user-agent': userAgent } : {}),
        },
        timeout: 8000,
        failOnStatusCode: false,
        maxRedirects: 0,
      },
    );

    if (response.status() === 404) return null;
    if (response.status() !== 200) {
      console.warn(`[SCRAPE] API do Instagram respondeu ${response.status()} - usando a pagina por ${IG_API_BACKOFF_MS / 60000} min.`);
      igApiBackoffUntil = Date.now() + IG_API_BACKOFF_MS;
      return undefined;
    }

    const json: any = await response.json().catch(() => null);
    if (!json) {
      igApiBackoffUntil = Date.now() + IG_API_BACKOFF_MS;
      return undefined;
    }
    const user = json?.data?.user;
    if (!user) return null;

    const followers = typeof user.edge_followed_by?.count === 'number' ? user.edge_followed_by.count : null;
    const postsCount = typeof user.edge_owner_to_timeline_media?.count === 'number' ? user.edge_owner_to_timeline_media.count : null;
    const bio: string | null = user.biography?.trim() || null;
    const displayName: string | null = user.full_name?.trim() || null;
    const website: string | null = user.external_url || user.bio_links?.[0]?.url || null;
    const category: string | null = user.category_name || user.business_category_name || null;
    const isPrivate = Boolean(user.is_private);
    const phone: string | null = user.business_phone_number
      || (bio?.match(/(\+?\d[\d\s().-]{6,}\d)/)?.[1] ?? null);

    let address = '';
    try {
      const parsed = user.business_address_json ? JSON.parse(user.business_address_json) : null;
      address = [parsed?.street_address, parsed?.city_name, parsed?.zip_code].filter(Boolean).join(', ');
    } catch {}

    // Mesmo papel do innerText da pagina: texto livre usado no score de
    // confianca (cidade/telefone) e no snippet que a IA de analise le.
    const profileText = [
      displayName,
      `@${cleanUsername}`,
      category,
      bio,
      website,
      phone,
      address,
      followers !== null ? `${followers} seguidores` : null,
      postsCount !== null ? `${postsCount} publicações` : null,
    ].filter(Boolean).join('\n').slice(0, 6000);

    return {
      username: cleanUsername,
      displayName,
      followers,
      bio,
      profileText,
      postsCount,
      isPrivate,
      isActive: !isPrivate && (postsCount ?? 0) > 0,
      category,
      website,
      phone,
    };
  } catch (err: any) {
    // Erro de rede/timeout: pausa curta pra nao pagar o timeout de novo em
    // cada candidato seguinte.
    console.warn(`[SCRAPE] Falha na API do Instagram para ${cleanUsername}:`, err?.message);
    igApiBackoffUntil = Date.now() + 60 * 1000;
    return undefined;
  }
}

export async function scrapeInstagramProfile(page: Page, username: string): Promise<InstagramProfileData | null> {
  // So perfis encontrados ficam em cache (1 dia): null pode ser bloqueio
  // temporario do Instagram, e cachear isso esconderia um perfil real.
  return cached('instagram-profile', [username.replace(/^@/, '')], async () => {
    const viaApi = await fetchInstagramProfileViaApi(page, username);
    if (viaApi !== undefined) return viaApi;
    return scrapeInstagramProfileFromPage(page, username);
  }, { ttlSeconds: CACHE_TTL.DAY, shouldCache: (profile) => profile !== null });
}

async function scrapeInstagramProfileFromPage(page: Page, username: string): Promise<InstagramProfileData | null> {
  const cleanUsername = (() => {
    const raw = String(username).trim();
    const withoutAt = raw.replace(/^@/, '');
    const withoutBaseUrl = withoutAt
      .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '')
      .replace(/^https?:\/\/(?:www\.)?instagram\.com$/i, '');
    const normalized = withoutBaseUrl.split(/[/?#]/)[0].trim();
    return normalized && /^[a-zA-Z0-9._]+$/.test(normalized) ? normalized.toLowerCase() : null;
  })();
  if (!cleanUsername) return null;

  try {
    await page.goto(`https://www.instagram.com/${cleanUsername}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  } catch (err: any) {
    console.error(`[SCRAPE] page.goto failed for ${cleanUsername}:`, err?.message);
    return null;
  }
  // Espera condicional (mesmo teto de 2,5s de antes): segue assim que o
  // cabecalho do perfil renderizar, em vez de sempre gastar o tempo inteiro.
  await page.waitForSelector('header section, main header', { timeout: 2500 }).catch(() => undefined);
  await page.waitForTimeout(300);

  const data = await page.evaluate(() => {
    const bodyText = document.body?.innerText ?? '';
    const metaDescription = document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? '';
    const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '';
    const displayName = title.split('•')[0]?.replace(/\(@[^)]+\)/, '').trim() || null;
    const isPrivate = /conta privada|private account/i.test(bodyText);
    const isNotFound = /sorry|nao encontrada|não encontrada|page not found|pagina nao encontrada/i.test(bodyText + title);
    if (isNotFound) return null;

    const followerMatch = (metaDescription + ' ' + bodyText).match(/([\d.,]+(?:\s*[kmKM])?)\s*(?:seguidores|followers)/i);
    const postsMatch = (metaDescription + ' ' + bodyText).match(/([\d.,]+(?:\s*[kmKM])?)\s*(?:publica|posts|publicações|publicacoes)/i);

    const header = document.querySelector('header');
    const bio = header?.querySelector('section')?.innerText?.split('\n').slice(1, 4).join(' ').trim() ?? null;
    const website = header?.querySelector('a[href^="http"]')?.getAttribute('href') ?? null;

    // try to find a phone number in the header or body text
    const phoneMatch = (header?.innerText + ' ' + bodyText).match(/(\+?\d[\d\s().-]{6,}\d)/);
    const phone = phoneMatch?.[1] ?? null;

    const categoryMatch = bodyText.match(/(?:Restaurante|Bar|Cafeteria|Pizzaria|Food|Shopping|Product\/service)/i);

    return {
      followersText: followerMatch?.[1] ?? null,
      postsText: postsMatch?.[1] ?? null,
      displayName,
      bio,
      profileText: bodyText.slice(0, 6000),
      isPrivate,
      category: categoryMatch?.[0] ?? null,
      isActive: !isPrivate && !/no posts yet|nenhuma publicação|sem publicações/i.test(bodyText),
      website,
      phone,
    };
  });

  if (!data) return null;

  return {
    username: cleanUsername,
    displayName: data.displayName,
    followers: parseCount(data.followersText),
    bio: data.bio,
    profileText: data.profileText,
    postsCount: parseCount(data.postsText),
    isPrivate: data.isPrivate,
    isActive: data.isActive,
    category: data.category,
    website: data.website,
    phone: data.phone,
  };
}

// Helper functions for normalization and comparisons
function normalizeString(val: string): string {
  return val
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function getCleanWords(val: string, removeGenerics: boolean = false): string[] {
  const normalized = normalizeString(val);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (removeGenerics) {
    const generics = new Set(['restaurante', 'pizzaria', 'hamburgueria', 'cafeteria', 'cafe', 'bar', 'lanchonete', 'delivery', 'comida', 'food', 'maceio', 'alagoas', 'mcz', 'oficial', 'e']);
    return words.filter(w => w.length >= 2 && !generics.has(w));
  }
  return words.filter(w => w.length >= 2);
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

function phonesMatch(phone1: string, phone2: string): boolean {
  const p1 = normalizePhone(phone1);
  const p2 = normalizePhone(phone2);
  if (p1.length < 8 || p2.length < 8) return false;
  const tail1_8 = p1.slice(-8);
  const tail2_8 = p2.slice(-8);
  return tail1_8 === tail2_8;
}

function normalizeWebsite(url: string): string {
  try {
    let clean = url.trim().toLowerCase();
    clean = clean.split('?')[0];
    clean = clean.replace(/^https?:\/\/(www\.)?/, '').replace(/^www\./, '');
    if (clean.endsWith('/')) {
      clean = clean.slice(0, -1);
    }
    return clean;
  } catch {
    return url.trim().toLowerCase();
  }
}

function websitesMatch(url1: string, url2: string): boolean {
  const w1 = normalizeWebsite(url1);
  const w2 = normalizeWebsite(url2);
  if (!w1 || !w2) return false;
  return w1 === w2 || w1.includes(w2) || w2.includes(w1);
}

// --- Busca de @ do Instagram em buscadores ---------------------------------
// Bing primeiro: responde em ~0,5s e traz o perfil certo com consultas
// "<nome> <cidade> instagram". O DuckDuckGo (buscador antigo) fica so como
// reserva - em algumas redes ele nem conecta (timeout de ~20s por consulta,
// 3 consultas por lead, era o maior gargalo da prospeccao). Um buscador que
// falhar por conexao fica de fora por alguns minutos (circuit breaker), pra
// nao pagar o timeout de novo em cada lead seguinte.
type SearchProvider = 'bing' | 'duckduckgo';
const SEARCH_PROVIDER_COOLDOWN_MS = 10 * 60 * 1000;
const searchProviderDownUntil: Record<SearchProvider, number> = { bing: 0, duckduckgo: 0 };

function isProviderAvailable(provider: SearchProvider) {
  return Date.now() >= searchProviderDownUntil[provider];
}

function markProviderDown(provider: SearchProvider, reason: string) {
  searchProviderDownUntil[provider] = Date.now() + SEARCH_PROVIDER_COOLDOWN_MS;
  console.warn(`[SEARCH] ${provider} indisponivel (${reason}) - ignorado por ${SEARCH_PROVIDER_COOLDOWN_MS / 60000} min.`);
}

// Extrai os @ de todos os links da pagina de resultados, desembrulhando os
// redirecionadores do Bing (/ck/a?...&u=a1<base64url>) e do DDG (?uddg=).
function extractInstagramHandlesFromResults(page: Page) {
  return page.evaluate(() => {
    const ignored = ['accounts', 'explore', 'reels', 'reel', 'p', 'direct', 'stories', 'tags', 'about', 'privacy', 'terms', 'login', 'signup', 'legal', 'popular'];
    // Sem funcoes nomeadas aqui dentro: este corpo roda no navegador, e
    // alguns compiladores (tsx/esbuild com keepNames) injetam um helper
    // __name que nao existe la.
    const rawUrls: string[] = [];

    for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      let href = anchor.href || '';
      try {
        const url = new URL(href);
        const bingTarget = url.searchParams.get('u');
        const ddgTarget = url.searchParams.get('uddg');
        if (url.hostname.endsWith('bing.com') && bingTarget?.startsWith('a1')) {
          const b64 = bingTarget.slice(2).replace(/-/g, '+').replace(/_/g, '/');
          href = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
        } else if (ddgTarget) {
          href = ddgTarget;
        }
      } catch {}
      rawUrls.push(href);
    }

    // O Bing tambem mostra a URL de destino no <cite> ("instagram.com › usuario").
    for (const cite of Array.from(document.querySelectorAll('cite'))) {
      const text = (cite.textContent ?? '').replace(/\s*›\s*/g, '/').replace(/\s+/g, '');
      if (text.includes('instagram.com/')) rawUrls.push(text.startsWith('http') ? text : `https://${text}`);
    }

    const values = new Set<string>();
    for (const raw of rawUrls) {
      if (!raw.includes('instagram.com')) continue;
      try {
        const url = new URL(raw);
        // Links do proprio buscador que so citam instagram.com na query
        // (ex.: bing.com/images?q=...instagram.com) nao sao perfis.
        if (!/(^|\.)instagram\.com$/i.test(url.hostname)) continue;
        const path = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)[0] ?? '';
        if (!path || ignored.includes(path.toLowerCase())) continue;
        if (/^[A-Za-z0-9._]+$/.test(path)) values.add(path.toLowerCase());
      } catch {
        // ignore malformed urls
      }
    }

    return Array.from(values).slice(0, 12);
  });
}

async function searchWithProvider(page: Page, provider: SearchProvider, query: string): Promise<string[]> {
  // Lista vazia nao e cacheada: pode ser captcha/bloqueio do buscador.
  return cached(`search-${provider}`, [query], async () => {
    const url = provider === 'bing'
      ? `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=pt-br&cc=BR`
      : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    return extractInstagramHandlesFromResults(page);
  }, { ttlSeconds: CACHE_TTL.WEEK, shouldCache: (handles) => handles.length > 0 });
}

function isConnectionError(err: any) {
  return /ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|Timeout .*exceeded|net::/i.test(String(err?.message ?? err));
}

export async function searchInstagramUsernames(
  page: Page,
  businessName: string,
  city: string | null,
): Promise<string[]> {
  const directCandidates = new Set<string>();
  const cityPart = city ?? '';

  const queriesByProvider: Record<SearchProvider, string[]> = {
    // O operador site: no Bing volta resultados vazios pra bot - a consulta
    // com a palavra "instagram" traz o perfil no topo.
    bing: [
      `${businessName} ${cityPart} instagram`.replace(/\s+/g, ' ').trim(),
      `${businessName} instagram`.replace(/\s+/g, ' ').trim(),
    ],
    duckduckgo: [
      `${businessName} ${cityPart} site:instagram.com`.replace(/\s+/g, ' ').trim(),
      `${businessName} Instagram ${cityPart}`.replace(/\s+/g, ' ').trim(),
    ],
  };

  for (const provider of ['bing', 'duckduckgo'] as SearchProvider[]) {
    if (!isProviderAvailable(provider)) continue;
    let providerWorked = false;

    for (const query of Array.from(new Set(queriesByProvider[provider]))) {
      if (!query) continue;
      try {
        const handles = await searchWithProvider(page, provider, query);
        providerWorked = true;
        for (const handle of handles) directCandidates.add(handle);
        // A 1a consulta quase sempre ja traz o perfil certo; so faz a
        // segunda quando ela veio fraca.
        if (directCandidates.size >= 3) break;
      } catch (err: any) {
        if (isConnectionError(err)) {
          markProviderDown(provider, String(err?.message ?? err).split('\n')[0].slice(0, 120));
          break;
        }
        // Outro erro (pagina diferente/bloqueio pontual): tenta a proxima consulta.
        console.warn(`[SEARCH] Falha em ${provider} ("${query}"):`, String(err?.message ?? err).split('\n')[0]);
      }
    }

    // So cai no buscador reserva se o principal nao funcionou ou nao achou nada.
    if (providerWorked && directCandidates.size > 0) break;
  }

  // Antes, quando o DuckDuckGo nao achava nada, esta funcao MESMA abria ate
  // 8 (depois 4) paginas reais do Instagram pra testar palpites mecanicos -
  // um dos maiores gargalos de tempo do enriquecimento (cada tentativa podia
  // levar ate 18s, e navegacoes "interrompidas" em sequencia rapida contra o
  // Instagram eram comuns, as vezes levando o enriquecimento de UM lead a
  // mais de 1 minuto so nessa etapa). Isso e redundante agora: os mesmos
  // palpites mecanicos (guessInstagramUsernames) E os palpites da IA
  // (suggestInstagramUsernamesWithAI) ja sao gerados e verificados de forma
  // mais limpa direto em enrichLeadWithInstagram (scrapeInstagramProfile,
  // com timeouts e espera mais adequados). Aqui so retorna o que o DDG achou
  // (rapido, sem tocar o Instagram) - o resto do trabalho de tentativa fica
  // por conta do fluxo principal, sem duplicar.
  return Array.from(directCandidates).slice(0, 10);
}

// Deprecated fallback to keep types clean if anything else calls it
export async function searchInstagramUsername(
  page: Page,
  businessName: string,
  city: string | null,
): Promise<string | null> {
  const list = await searchInstagramUsernames(page, businessName, city);
  return list[0] ?? null;
}

export function calculateConfidenceScore(
  profile: InstagramProfileData,
  businessName: string,
  city: string | null,
  leadPhone: string | null,
  leadWebsite: string | null,
) {
  let score = 0;
  const signals: string[] = [];
  const contradictions: string[] = [];

  const textBlob = `${profile.displayName ?? ''} ${profile.bio ?? ''} ${profile.category ?? ''} ${profile.profileText ?? ''}`.toLowerCase();
  const businessCompact = normalizeName(businessName).replace(/[^a-z0-9]/g, '');
  const businessNameCompactish = businessCompact.slice(0, 24);
  const businessWords = getCleanWords(businessName, true);
  const dispNameWords = profile.displayName ? getCleanWords(profile.displayName, false) : [];

  // 1. Name Similarity (Max 35 points: displayName Sim max 30, username Sim max 5)
  let nameSim = 0;
  if (businessWords.length > 0 && dispNameWords.length > 0) {
    const matches = businessWords.filter(w => dispNameWords.includes(w) || dispNameWords.some(dw => dw.includes(w) || w.includes(dw)));
    nameSim = matches.length / businessWords.length;
  }

  const displayNamePoints = Math.round(nameSim * 30);
  if (displayNamePoints > 0) {
    score += displayNamePoints;
    signals.push('name');
  }

  const usernameWords = getCleanWords(profile.username, false);
  let userSim = 0;
  if (businessWords.length > 0 && usernameWords.length > 0) {
    const matches = businessWords.filter(w => usernameWords.includes(w) || usernameWords.some(uw => uw.includes(w) || w.includes(uw)));
    userSim = matches.length / businessWords.length;
  }
  const usernamePoints = Math.round(userSim * 5);
  if (usernamePoints > 0) {
    score += usernamePoints;
  }

  const usernameCompact = normalizeName(profile.username).replace(/[^a-z0-9]/g, '');
  if (businessNameCompactish && usernameCompact) {
    const compactNameMatch = usernameCompact.includes(businessNameCompactish) || businessNameCompactish.includes(usernameCompact.slice(0, 8));
    if (compactNameMatch) {
      score += 18;
      signals.push('name');
    }
  }

  const bioMatchesBrand = !!(profile.bio && normalizeString(profile.bio).includes(normalizeString(businessName)));
  const bioMatchesCompact = !!(profile.bio && normalizeString(profile.bio).includes(businessCompact.slice(0, 12)));
  if (bioMatchesBrand || bioMatchesCompact) {
    score += 20;
    signals.push('segment');
  }

  // 2. Segment / Bio matching (Max 20 points)
  const bioKeywords = ['restaurante', 'pizzaria', 'hamburgueria', 'hamburg', 'burguer', 'burger', 'lanchonete', 'cafeteria', 'cafe', 'bar', 'delivery', 'ifood', 'rappi', 'comida', 'gastronomia', 'doce', 'doceria', 'confeitaria', 'churrascaria', 'sushi', 'temaki', 'massas', 'cozinha', 'bistro', 'bistrô', 'gourmet', 'cardapio', 'cardápio', 'menu', 'cerveja', 'chopp', 'pub', 'coquetel', 'bebida', 'sabor', 'delicias', 'almoço', 'jantar', 'comer', 'cozinhar', 'chefe', 'chef', 'tortas', 'sobremesa', 'gelateria', 'sorveteria', 'acai', 'açaí'];
  const hasBioMatch = bioKeywords.some(kw => textBlob.includes(kw));
  if (hasBioMatch) {
    score += 20;
    signals.push('segment');
  }

  const displayNameMatch = profile.displayName ? normalizeString(profile.displayName).includes(normalizeString(businessName)) : false;
  if (displayNameMatch) {
    score += 12;
    signals.push('name');
  }

  const businessNameVariants = Array.from(new Set([
    normalizeString(businessName),
    normalizeString(businessName).replace(/\s+(de|da|do|dos|das|e|em)\s+/g, ' '),
    normalizeString(businessName).replace(/\s+/g, ''),
    normalizeString(profile.displayName ?? businessName),
  ].filter(Boolean)));

  const bioContainsBusiness = !!(profile.bio && businessNameVariants.some((variant) => {
    if (!variant) return false;
    return normalizeString(profile.bio ?? '').includes(variant) || (variant.length >= 8 && normalizeString(profile.bio ?? '').includes(`@${variant}`));
  }));
  const usernameContainsBusiness = !!(profile.username && businessNameVariants.some((variant) => {
    if (!variant || variant.length < 4) return false;
    return normalizeString(profile.username).includes(variant) || variant.includes(normalizeString(profile.username));
  }));
  if (bioContainsBusiness || usernameContainsBusiness) {
    score += 18;
    signals.push('name');
  }

  // 3. Location / City Match (Max 20 points)
  const targetCity = city ? normalizeString(city) : 'maceio';
  const isMaceio = targetCity === 'maceio';
  
  let hasCityMatch = textBlob.includes(targetCity);
  if (isMaceio) {
    const maceioIndicators = ['mcz', 'alagoas', ' jatiuca', ' jatiúca', 'ponta verde', 'pajucara', 'pajuçara', 'farol', 'antares', 'serraria', 'benedito bentes', 'stella maris', 'cruz das almas', 'mangabeiras'];
    if (maceioIndicators.some(ind => textBlob.includes(ind))) {
      hasCityMatch = true;
    }
  }

  if (hasCityMatch) {
    score += 20;
    signals.push('city');
  }

  // 4. Exact Contact Match (Max 30 points each, score normalized max 100)
  let hasPhoneMatch = false;
  if (leadPhone && profile.phone) {
    if (phonesMatch(leadPhone, profile.phone)) {
      hasPhoneMatch = true;
      score += 30;
      signals.push('phone');
    }
  }

  let hasWebsiteMatch = false;
  if (leadWebsite && profile.website) {
    if (websitesMatch(leadWebsite, profile.website)) {
      hasWebsiteMatch = true;
      score += 30;
      signals.push('website');
    }
  }

  // 5. Followers & Posts Plausibility Modifier (Max ±3 points)
  let plausibilityModifier = 0;
  if (profile.followers !== null) {
    if (profile.followers < 100) {
      plausibilityModifier -= 3;
    } else if (profile.followers > 5000) {
      plausibilityModifier += 3;
    } else if (profile.followers > 1000) {
      plausibilityModifier += 2;
    }
  }
  if (profile.postsCount !== null) {
    if (profile.postsCount === 0) {
      plausibilityModifier -= 3;
    } else if (profile.postsCount > 5) {
      plausibilityModifier += 1;
    }
  }
  // Cap plausibility modifier at ±3 points
  plausibilityModifier = Math.max(-3, Math.min(3, plausibilityModifier));
  score += plausibilityModifier;

  // 6. Contradictions (Reject / Cap)
  // City contradiction
  const otherCities = ['sao paulo', 'rio de janeiro', 'belo horizonte', 'curitiba', 'fortaleza', 'recife', 'salvador', 'porto alegre', 'manaus', 'brasilia', 'goiania', 'natal', 'joao pessoa', 'aracaju', 'florianopolis', 'vitoria', 'cuiaba', 'campo grande', 'teresina', 'sao luis', 'belem', 'porto velho', 'rio branco', 'boa vista', 'macapa', 'palmas', 'campinas', 'santos', 'niteroi'];
  const contradictionsFound = otherCities.filter(other => {
    if (city && other === normalizeString(city)) return false;
    const regex = new RegExp(`\\b${other}\\b`, 'i');
    return regex.test(textBlob);
  });

  if (contradictionsFound.length > 0 && !hasCityMatch) {
    contradictions.push('wrong_city');
  }

  // Ramo/Segment contradiction
  const negativeKeywords = ['moda', 'vestuario', 'roupa', 'calcado', 'shoes', 'acessorios', 'estetica', 'nails', 'cilios', 'unhas', 'hair', 'salao de beleza', 'maquiagem', 'makeup', 'fotografo', 'photography', 'advogado', 'advocacia', 'consultoria', 'imoveis', 'corretor', 'imobiliaria', 'noticias', 'noticia', 'memes', 'meme', 'influenciador', 'influencer', 'revendedor', 'revenda', 'personal trainer', 'clinica', 'medico', 'dentista', 'odontologia', 'arquiteto', 'arquitetura', 'engenharia'];
  const hasNegativeKeyword = negativeKeywords.some(kw => {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    return regex.test(textBlob);
  });

  if (hasNegativeKeyword && !hasPhoneMatch && !hasWebsiteMatch) {
    contradictions.push('wrong_segment');
  }

  // Apply contradiction penalties (capping score below 60, e.g. 20)
  if (contradictions.length > 0) {
    score = Math.min(score, 20);
  }

  // Ensure within 0-100 range
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    signals,
    contradictions,
  };
}

export function selectInstagramWinner(
  scoredProfiles: Array<{
    profile: InstagramProfileData;
    score: number;
    method: string;
    signals: string[];
    contradictions: string[];
  }>
): { profile: InstagramProfileData; score: number; method: string; signals: string[]; contradictions: string[] } | null {
  if (!scoredProfiles.length) return null;

  const filtered = scoredProfiles.filter((item) => {
    const contradictions = item.contradictions ?? [];
    const signals = item.signals ?? [];
    const hasFatalConflict = contradictions.some((c) => ['wrong_city', 'wrong_segment'].includes(c));
    const hasStrongSignal = signals.some((s) => ['name', 'city', 'phone', 'website', 'segment'].includes(s));
    return !hasFatalConflict && (item.score >= 60 || hasStrongSignal);
  });

  const ranked = (filtered.length ? filtered : scoredProfiles)
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;

      const aSignalStrength = a.signals.filter((s) => ['name', 'city', 'phone', 'website', 'segment'].includes(s)).length;
      const bSignalStrength = b.signals.filter((s) => ['name', 'city', 'phone', 'website', 'segment'].includes(s)).length;
      if (aSignalStrength !== bSignalStrength) return bSignalStrength - aSignalStrength;

      const aContradictions = a.contradictions.length;
      const bContradictions = b.contradictions.length;
      if (aContradictions !== bContradictions) return aContradictions - bContradictions;

      return a.profile.followers && b.profile.followers ? (b.profile.followers ?? 0) - (a.profile.followers ?? 0) : 0;
    })
    .slice(0, 1);

  return ranked[0] ?? null;
}

export async function enrichLeadWithInstagram(
  page: Page,
  lead: typeof leads.$inferSelect,
): Promise<{ updated: boolean; profile: InstagramProfileData | null; method: string | null; diagnostics?: any }> {
  console.log(`[InstagramValidation] Iniciando busca para: "${lead.businessName}" em "${lead.city ?? 'Maceió'}"`);
  
  const candidatesSet = new Set<string>();
  const candidateSources = new Map<string, string>();

  // 1. Existing Username
  if (lead.instagramUsername) {
    const clean = (() => {
      const raw = String(lead.instagramUsername).trim();
      const withoutAt = raw.replace(/^@/, '');
      const withoutBaseUrl = withoutAt
        .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '')
        .replace(/^https?:\/\/(?:www\.)?instagram\.com$/i, '');
      const normalized = withoutBaseUrl.split(/[/?#]/)[0].trim();
      return normalized && /^[a-zA-Z0-9._]+$/.test(normalized) ? normalized.toLowerCase() : null;
    })();
    if (clean) {
      candidatesSet.add(clean);
      candidateSources.set(clean, 'existing_username');
    }
  }

  // 2/3/AI. Website, busca no DuckDuckGo e sugestao por IA rodam em PARALELO
  // (antes eram 3 passos sequenciais - o site sozinho ja podia levar alguns
  // segundos, e so depois disso comecava a busca no DDG). A IA (OpenRouter)
  // costuma responder em ~1-2s e da palpites de username bem mais
  // direcionados que a combinatoria mecanica de guessInstagramUsernames -
  // colocados com prioridade alta na lista, um palpite bom da IA reduz
  // quantas paginas reais do Instagram precisam ser abertas ate achar o
  // perfil certo (o "break" na linha do score >=80 para assim que acerta).
  const [websiteResult, searchResult, aiResult] = await Promise.allSettled([
    lead.website ? findInstagramOnWebsite(lead.website) : Promise.resolve(null),
    searchInstagramUsernames(page, lead.businessName, lead.city),
    suggestInstagramUsernamesWithAI(lead.businessName, lead.city, lead.category),
  ]);

  if (websiteResult.status === 'fulfilled' && websiteResult.value) {
    const clean = websiteResult.value.replace(/^@/, '').trim().toLowerCase();
    if (clean) {
      candidatesSet.add(clean);
      if (!candidateSources.has(clean)) candidateSources.set(clean, 'website');
    }
  } else if (websiteResult.status === 'rejected') {
    console.warn('[ENRICHMENT] findInstagramOnWebsite failed:', websiteResult.reason);
  }

  if (aiResult.status === 'fulfilled') {
    for (const user of aiResult.value) {
      const clean = user.replace(/^@/, '').trim().toLowerCase();
      if (clean) {
        candidatesSet.add(clean);
        if (!candidateSources.has(clean)) candidateSources.set(clean, 'ai_suggestion');
      }
    }
  }

  if (searchResult.status === 'fulfilled') {
    for (const user of searchResult.value) {
      const clean = user.replace(/^@/, '').trim().toLowerCase();
      if (clean) {
        candidatesSet.add(clean);
        if (!candidateSources.has(clean)) candidateSources.set(clean, 'instagram_search');
      }
    }
  } else {
    console.warn('[ENRICHMENT] searchInstagramUsernames failed:', searchResult.reason);
  }

  const directCompactNames = Array.from(new Set(guessInstagramUsernames(lead.businessName))).slice(0, 4);
  for (const compactName of directCompactNames) {
    if (compactName) {
      candidatesSet.add(compactName);
      if (!candidateSources.has(compactName)) {
        candidateSources.set(compactName, 'username_guess');
      }
    }
  }

  // 4. Guesses (fallback/auxiliary)
  try {
    const guesses = guessInstagramUsernames(lead.businessName).slice(0, 3);
    for (const guess of guesses) {
      const clean = guess.replace(/^@/, '').trim().toLowerCase();
      if (clean) {
        candidatesSet.add(clean);
        if (!candidateSources.has(clean)) {
          candidateSources.set(clean, 'username_guess');
        }
      }
    }
  } catch (e) {
    console.warn('[ENRICHMENT] guessInstagramUsernames failed:', e);
  }

  const orderedUsernames: string[] = [];
  const priorityOrder = ['website', 'existing_username', 'ai_suggestion', 'instagram_search', 'username_guess'];
  for (const pMethod of priorityOrder) {
    for (const user of candidatesSet) {
      if (candidateSources.get(user) === pMethod && !orderedUsernames.includes(user)) {
        orderedUsernames.push(user);
      }
    }
  }
  for (const user of candidatesSet) {
    if (!orderedUsernames.includes(user)) {
      orderedUsernames.push(user);
    }
  }

  const candidatesToProcess = orderedUsernames.slice(0, 3);

  // Busca os candidatos via API em PARALELO (antes: uma pagina inteira por
  // candidato, em sequencia). A ordem de avaliacao abaixo continua a mesma -
  // so os dados ja chegam prontos. Quem a API nao respondeu (undefined) cai
  // na leitura pela pagina, uma por vez (a Page nao aceita navegacao
  // concorrente).
  const prefetched = new Map<string, InstagramProfileData | null | undefined>(
    await Promise.all(candidatesToProcess.map(async (username) =>
      [username, await fetchInstagramProfileViaApi(page, username)] as const,
    )),
  );
  const getProfile = async (username: string) => {
    const cached = prefetched.get(username);
    if (cached !== undefined) return cached;
    const profile = await scrapeInstagramProfile(page, username);
    prefetched.set(username, profile);
    return profile;
  };

  const scoredProfiles: Array<{
    profile: InstagramProfileData;
    score: number;
    method: string;
    signals: string[];
    contradictions: string[];
  }> = [];

  for (const username of candidatesToProcess) {
    try {
      const profile = await getProfile(username);
      if (!profile || profile.isPrivate) {
        console.log(`[InstagramValidation] lead="${lead.businessName}" candidate="@${username}" score=0 signals=[] contradictions=["private_or_not_found"] decision="rejected"`);
        continue;
      }

      const scoreResult = calculateConfidenceScore(
        profile,
        lead.businessName,
        lead.city,
        lead.phone,
        lead.website
      );

      let finalScore = scoreResult.score;
      const method = candidateSources.get(username) || 'unknown';

      if (finalScore >= 80) {
        const uniqueSignals = scoreResult.signals.filter(s => ['name', 'city', 'phone', 'website', 'segment'].includes(s));
        if (uniqueSignals.length < 2) {
          finalScore = 79;
        }
      }

      // 'username_guess' e 'ai_suggestion' sao PALPITES, nao evidencia real
      // (diferente de 'website'/'existing_username', que vem de um link que
      // o proprio negocio publicou). Um nome comum ("Paladar", "Estilo",
      // "Opção"...) pode bater com um perfil de outra cidade inteira so por
      // coincidencia de nome+segmento - "segmento" aqui e fraco demais pra
      // servir de confirmacao (e so um bater de palavras genericas tipo
      // "restaurante"/"delivery" que qualquer perfil do ramo tem, nao prova
      // que e o MESMO estabelecimento). Por isso exige cidade, telefone ou
      // site batendo de verdade - nao aceita so por nome+segmento.
      if ((method === 'username_guess' || method === 'ai_suggestion') && finalScore >= 80) {
        const hasStrongCorroboration = scoreResult.signals.includes('city') || scoreResult.signals.includes('phone') || scoreResult.signals.includes('website');
        if (!(scoreResult.signals.includes('name') && hasStrongCorroboration)) {
          finalScore = 79;
        }
      }

      const decision = finalScore >= 80 ? 'accepted' : finalScore >= 60 ? 'probable' : 'rejected';
      console.log(`[InstagramValidation] lead="${lead.businessName}" candidate="@${username}" score=${finalScore} signals=${JSON.stringify(scoreResult.signals)} contradictions=${JSON.stringify(scoreResult.contradictions)} decision="${decision}"`);

      scoredProfiles.push({
        profile,
        score: finalScore,
        method,
        signals: scoreResult.signals,
        contradictions: scoreResult.contradictions,
      });

      if (finalScore >= 80) {
        break;
      }
    } catch (err: any) {
      console.warn(`[ENRICHMENT] Error processing @${username}:`, err?.message);
    }
  }

  if (scoredProfiles.length === 0 && orderedUsernames.length > 1) {
    const fallbackCandidates = orderedUsernames.slice(1, 3);
    for (const username of fallbackCandidates) {
      try {
        const profile = await getProfile(username);
        if (!profile || profile.isPrivate) continue;
        const scoreResult = calculateConfidenceScore(profile, lead.businessName, lead.city, lead.phone, lead.website);
        scoredProfiles.push({
          profile,
          score: scoreResult.score,
          method: candidateSources.get(username) || 'unknown',
          signals: scoreResult.signals,
          contradictions: scoreResult.contradictions,
        });
      } catch {
        // fallback only; do not loop forever
      }
    }
  }

  // Filter candidates
  const acceptedCandidates = scoredProfiles.filter(c => c.score >= 80).sort((a, b) => b.score - a.score);
  const probableCandidates = scoredProfiles.filter(c => c.score >= 60 && c.score < 80).sort((a, b) => b.score - a.score);

  let selected: typeof scoredProfiles[0] | null = null;
  let validationMethod: string | null = null;

  if (acceptedCandidates.length > 0) {
    selected = selectInstagramWinner(acceptedCandidates) ?? acceptedCandidates[0];
    validationMethod = selected.method;
  } else if (probableCandidates.length > 0) {
    // Um candidato "provável" (score 60-79) que veio de PALPITE
    // (ai_suggestion/username_guess) SEM cidade/telefone/site confirmando de
    // verdade na bio nunca e aceito - nem por regra determinística, nem
    // mandando pra IA decidir. Testado na pratica: a IA, sem nenhuma
    // evidência real de localização pra avaliar, tende a "confirmar" so pela
    // plausibilidade generica de nome+categoria (ex.: "a categoria é
    // compatível com a região") - exatamente o tipo de falso positivo que
    // fazia perfis de OUTRA cidade passar (nomes comuns como "Paladar",
    // "Estilo" existem em varias cidades). Sem evidência real, o candidato e
    // rejeitado direto por segurança - melhor nao mandar mensagem do que
    // mandar pro negocio errado.
    const hasRealCorroboration = (c: typeof probableCandidates[number]) =>
      c.method === 'website' || c.method === 'existing_username' ||
      c.signals.includes('city') || c.signals.includes('phone') || c.signals.includes('website');
    const corroboratedCandidates = probableCandidates.filter(hasRealCorroboration);

    if (corroboratedCandidates.length === 0) {
      console.log(`[InstagramValidation] Candidatos prováveis para "${lead.businessName}" sao so palpite sem confirmação real de cidade/telefone/site - rejeitados por segurança.`);
    }

    const deterministicWinner = corroboratedCandidates.length > 0 ? selectInstagramWinner(corroboratedCandidates) : null;
    if (deterministicWinner) {
      selected = deterministicWinner;
      validationMethod = `deterministic_${deterministicWinner.method}`;
      console.log(`[InstagramValidation] Selecionado por regra determinística: @${selected.profile.username} score=${selected.score}`);
    } else if (corroboratedCandidates.length > 0) {
      const topProbable = corroboratedCandidates.slice(0, 3);
      const aiLead = {
        businessName: lead.businessName,
        city: lead.city,
        neighborhood: lead.neighborhood,
        category: lead.category,
        phone: lead.phone,
        website: lead.website,
      };
      const aiCandidates = topProbable.map(c => ({
        username: c.profile.username,
        displayName: c.profile.displayName,
        bio: c.profile.bio,
        category: c.profile.category,
        followers: c.profile.followers,
        postsCount: c.profile.postsCount,
        website: c.profile.website ?? null,
        phone: c.profile.phone ?? null,
        score: c.score,
      }));

      console.log(`[InstagramValidation] Enviando ${aiCandidates.length} candidatos ambíguos para validação via IA...`);
      const aiResult = await disambiguateInstagramCandidates(aiLead, aiCandidates);

      if (aiResult.matched && aiResult.username) {
        const match = probableCandidates.find(c => c.profile.username.toLowerCase() === aiResult.username?.toLowerCase());
        if (match) {
          selected = match;
          validationMethod = `ai_confirmed_${match.method}`;
          console.log(`[InstagramValidation] IA confirmou o perfil @${selected.profile.username} com confiança ${aiResult.confidence}. Motivo: ${aiResult.reason}`);
        }
      } else {
        console.log(`[InstagramValidation] IA não confirmou nenhum candidato. Motivo: ${aiResult.reason}`);
      }
    }
  }

  if (!selected) {
    console.log(`[InstagramValidation] Nenhum perfil confirmado para: "${lead.businessName}"`);
    await db.update(leads).set({
      enrichmentStatus: 'FAILED',
      enrichmentAttemptedAt: new Date(),
    }).where(eq(leads.id, lead.id));
    return { updated: false, profile: null, method: null };
  }

  const { profile, score } = selected;
  const bioLower = (profile.bio ?? '').toLowerCase();
  const now = new Date();
  const websiteDomain = profile.website ? normalizeWebsite(profile.website) : null;

  const diagnostics = {
    method: validationMethod,
    score,
    signals: selected.signals,
    scrapedAt: now.toISOString(),
    profileSnippet: (profile.profileText ?? '').slice(0, 2000),
    phone: profile.phone ?? null,
    website: profile.website ?? null,
  };

  const patch = {
    businessName: lead.businessName.startsWith('@') && profile.displayName
      ? profile.displayName
      : lead.businessName,
    instagramUsername: profile.username,
    instagramUrl: `https://www.instagram.com/${profile.username}/`,
    followers: profile.followers,
    postsCount: profile.postsCount,
    profileSnippet: profile.profileText?.slice(0, 2000) ?? null,
    instagramActive: profile.isActive,
    notes: JSON.stringify({ ...(lead.notes ? { previousNotes: lead.notes } : {}), igBio: profile.bio ?? undefined }),
    category: lead.category ?? profile.category,
    hasDelivery: lead.hasDelivery ?? (/delivery|ifood|rappi|entrega/i.test(bioLower) ? true : null),
    hasDiningRoom: lead.hasDiningRoom ?? (/sal[aã]o|mesa|garçom|garcom|rod[ií]zio/i.test(bioLower) ? true : null),
    hasWaiters: lead.hasWaiters ?? (/garçom|garcom|sal[aã]o/i.test(bioLower) ? true : null),
    phone: lead.phone ?? profile.phone ?? lead.phone,
    website: lead.website ?? profile.website ?? lead.website,
    websiteDomain: lead.websiteDomain ?? websiteDomain ?? lead.websiteDomain,
    profileScore: score,
    profileAccepted: true,
    profileDiagnostics: JSON.stringify(diagnostics),
    enrichmentStatus: 'DONE',
    enrichmentAttemptedAt: now,
    updatedAt: now,
  } as any;

  await db.update(leads).set(patch).where(eq(leads.id, lead.id));
  await db.insert(activities).values({
    id: crypto.randomUUID(),
    leadId: lead.id,
    type: 'NOTE',
    channel: 'INSTAGRAM',
    content: `[ENRICHMENT] Instagram @${profile.username} confirmado via ${validationMethod}. Score: ${score}. Seguidores: ${profile.followers ?? '?'}.`,
    metadata: JSON.stringify({ method: validationMethod, diagnostics, profile }),
    createdAt: now,
  });

  return { updated: true, profile, method: validationMethod, diagnostics };
}

