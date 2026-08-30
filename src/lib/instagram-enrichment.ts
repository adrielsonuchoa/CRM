import type { Page } from 'playwright';
import { db } from '@/db';
import { activities, leads } from '@/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { findInstagramOnWebsite } from '@/lib/prospecting-sources';
import { disambiguateInstagramCandidates } from '@/app/actions/ai';


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

function meaningfulWords(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
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

function scoreUsernameMatch(businessName: string, username: string) {
  const normalizedBusiness = normalizeName(businessName);
  const normalizedUsername = normalizeName(username);
  if (!normalizedBusiness || !normalizedUsername) return 0;

  const businessCompact = normalizedBusiness.replace(/[^a-z0-9]/g, '');
  const usernameCompact = normalizedUsername.replace(/[^a-z0-9]/g, '');

  if (usernameCompact === businessCompact) return 100;
  if (businessCompact.includes(usernameCompact) || usernameCompact.includes(businessCompact)) return 90;
  if (usernameCompact.includes(businessCompact.slice(0, 10)) || businessCompact.includes(usernameCompact.slice(0, 10))) return 80;

  const businessWords = businessName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !['restaurante', 'restaurantes', 'pizzaria', 'pizzarias', 'bar', 'cafe', 'cafeteria', 'lanchonete', 'delivery', 'maceio', 'al', 'mcz', 'hamburgueria', 'hamburguerias'].includes(word));

  const hits = businessWords.filter((word) => username.toLowerCase().includes(word)).length;
  if (hits === 0) return 0;
  return Math.min(70, hits * 25);
}

export async function scrapeInstagramProfile(page: Page, username: string): Promise<InstagramProfileData | null> {
  const cleanUsername = username.replace(/^@/, '').trim().toLowerCase();
  if (!cleanUsername) return null;

  await page.goto(`https://www.instagram.com/${cleanUsername}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(2500);

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
  } catch (e) {
    return url.trim().toLowerCase();
  }
}

function websitesMatch(url1: string, url2: string): boolean {
  const w1 = normalizeWebsite(url1);
  const w2 = normalizeWebsite(url2);
  if (!w1 || !w2) return false;
  return w1 === w2 || w1.includes(w2) || w2.includes(w1);
}

export async function searchInstagramUsernames(
  page: Page,
  businessName: string,
  city: string | null,
): Promise<string[]> {
  const directCandidates = new Set<string>();

  const ddgQueries = [
    `${businessName} ${city ?? ''} site:instagram.com`.trim(),
    `${businessName} Instagram ${city ?? ''}`.trim(),
    `${businessName} ${city ?? ''}`.trim(),
  ];

  for (const query of ddgQueries) {
    if (!query) continue;

    try {
      await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(1800);

      const handles = await page.evaluate(() => {
        const values = new Set<string>();
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));

        for (const anchor of links) {
          const href = anchor.href || '';
          if (!href.includes('instagram.com')) continue;
          try {
            const url = new URL(href);
            const path = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)[0] ?? '';
            if (!path || ['accounts', 'explore', 'reels', 'p', 'direct', 'stories', 'tags', 'about', 'privacy', 'terms', 'login', 'signup'].includes(path.toLowerCase())) continue;
            if (/^[A-Za-z0-9._]+$/.test(path)) values.add(path.toLowerCase());
          } catch {
            // ignore malformed urls
          }
        }

        return Array.from(values).slice(0, 12);
      });

      for (const handle of handles) {
        directCandidates.add(handle);
      }

      if (directCandidates.size >= 10) break;
    } catch {
      // DuckDuckGo may block the bot or return a different page; continue with the next fallback
    }
  }

  if (directCandidates.size > 0) {
    return Array.from(directCandidates).slice(0, 10);
  }

  const fallbackGuesses = Array.from(
    new Set([
      ...guessInstagramUsernames(businessName),
      ...(city ? guessInstagramUsernames(`${businessName} ${city}`) : []),
      ...(businessName ? guessInstagramUsernames(businessName.replace(/\s+/g, '')) : []),
    ])
  ).slice(0, 8);

  for (const candidate of fallbackGuesses) {
    try {
      await page.goto(`https://www.instagram.com/${candidate}/`, { waitUntil: 'domcontentloaded', timeout: 18000 });
      await page.waitForTimeout(900);
      const content = await page.locator('body').innerText({ timeout: 4000 }).catch(() => '');
      const title = await page.title().catch(() => '');
      const isLikelyProfile = !!content && !/Log In to Instagram|Entrar no Instagram|Page Not Found|Sorry|This page could not be found|Cadastre-se|temporariamente bloqueada|challenge|captcha/i.test(`${title} ${content}`);
      if (isLikelyProfile) {
        directCandidates.add(candidate.toLowerCase());
        break;
      }
    } catch {
      // ignore and continue with the next candidate
    }
  }

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
    const clean = lead.instagramUsername.replace(/^@/, '').trim().toLowerCase();
    if (clean) {
      candidatesSet.add(clean);
      candidateSources.set(clean, 'existing_username');
    }
  }

  // 2. Website Instagram
  if (lead.website) {
    try {
      const fromWebsite = await findInstagramOnWebsite(lead.website);
      if (fromWebsite) {
        const clean = fromWebsite.replace(/^@/, '').trim().toLowerCase();
        if (clean) {
          candidatesSet.add(clean);
          if (!candidateSources.has(clean)) {
            candidateSources.set(clean, 'website');
          }
        }
      }
    } catch (e) {
      console.warn('[ENRICHMENT] findInstagramOnWebsite failed:', e);
    }
  }

  // 3. Search candidates
  try {
    const searchResults = await searchInstagramUsernames(page, lead.businessName, lead.city);
    for (const user of searchResults) {
      const clean = user.replace(/^@/, '').trim().toLowerCase();
      if (clean) {
        candidatesSet.add(clean);
        if (!candidateSources.has(clean)) {
          candidateSources.set(clean, 'instagram_search');
        }
      }
    }
  } catch (e) {
    console.warn('[ENRICHMENT] searchInstagramUsernames failed:', e);
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
  const priorityOrder = ['website', 'existing_username', 'instagram_search', 'username_guess'];
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
  const scoredProfiles: Array<{
    profile: InstagramProfileData;
    score: number;
    method: string;
    signals: string[];
    contradictions: string[];
  }> = [];

  for (const username of candidatesToProcess) {
    try {
      const profile = await scrapeInstagramProfile(page, username);
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

      if (method === 'username_guess' && finalScore >= 80) {
        const hasOtherSignal = scoreResult.signals.includes('city') || scoreResult.signals.includes('phone') || scoreResult.signals.includes('website') || scoreResult.signals.includes('segment');
        if (!(scoreResult.signals.includes('name') && hasOtherSignal)) {
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
        const profile = await scrapeInstagramProfile(page, username);
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
    const deterministicWinner = selectInstagramWinner(probableCandidates);
    if (deterministicWinner) {
      selected = deterministicWinner;
      validationMethod = `deterministic_${deterministicWinner.method}`;
      console.log(`[InstagramValidation] Selecionado por regra determinística: @${selected.profile.username} score=${selected.score}`);
    } else {
      const topProbable = probableCandidates.slice(0, 3);
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

