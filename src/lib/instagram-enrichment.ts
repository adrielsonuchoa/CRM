import type { Page } from 'playwright';
import { db } from '@/db';
import { activities, leads } from '@/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { findInstagramOnWebsite } from '@/lib/prospecting-sources';

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
  const words = businessName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !['restaurante', 'pizzaria', 'bar', 'cafe', 'lanchonete', 'delivery'].includes(word));

  const guesses = new Set<string>();
  if (words[0]) guesses.add(words[0]);
  if (words.length >= 2) guesses.add(words.slice(0, 2).join(''));
  if (words.length >= 2) guesses.add(`${words[0]}_${words[1]}`);
  if (words.length >= 3) guesses.add(words.slice(0, 3).join(''));
  guesses.add(normalizeName(businessName).slice(0, 30));
  return Array.from(guesses).filter((value) => value.length >= 3 && /^[a-z0-9._]+$/.test(value));
}

function scoreUsernameMatch(businessName: string, username: string) {
  const normalizedBusiness = normalizeName(businessName);
  const normalizedUsername = normalizeName(username);
  if (!normalizedBusiness || !normalizedUsername) return 0;
  if (normalizedBusiness.includes(normalizedUsername) || normalizedUsername.includes(normalizedBusiness.slice(0, 8))) return 100;
  const businessWords = businessName.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3);
  const hits = businessWords.filter((word) => username.toLowerCase().includes(word)).length;
  return hits * 25;
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
  };
}

export async function searchInstagramUsername(
  page: Page,
  businessName: string,
  city: string | null,
): Promise<string | null> {
  const query = `${businessName}${city ? ` ${city}` : ''}`.trim();
  await page.goto(`https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(query)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(3000);

  const candidates = await page.evaluate(() => {
    const ignored = new Set(['explore', 'accounts', 'reels', 'p', 'direct', 'web', 'popular', 'legal', 'about', 'privacy', 'terms']);
    return Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'))
      .map((anchor) => ({
        username: (anchor.getAttribute('href') ?? '').split('/').filter(Boolean)[0] ?? '',
        label: anchor.textContent?.trim() ?? '',
      }))
      .filter(({ username }) => username && !ignored.has(username.toLowerCase()) && /^[A-Za-z0-9._]+$/.test(username))
      .slice(0, 20);
  });

  if (candidates.length === 0) return null;

  const ranked = candidates
    .map((candidate) => ({
      username: candidate.username,
      score: Math.max(scoreUsernameMatch(businessName, candidate.username), scoreUsernameMatch(businessName, candidate.label)),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked.find((item) => item.score >= 25);
  return best?.username.toLowerCase() ?? null;
}

function profileMatchScore(profile: InstagramProfileData, businessName: string, city: string | null) {
  const businessWords = meaningfulWords(businessName).filter((word) => !['restaurante', 'pizzaria', 'hamburgueria', 'lanchonete', 'cafeteria', 'cafe', 'bar', 'delivery'].includes(word));
  const profileWords = meaningfulWords(`${profile.username} ${profile.displayName ?? ''} ${profile.bio ?? ''}`);
  const matchingWords = businessWords.filter((word) => profileWords.some((candidate) => candidate === word || candidate.includes(word) || word.includes(candidate)));
  const nameScore = businessWords.length > 0 ? matchingWords.length / businessWords.length : 0;
  const normalizedProfile = normalizeName(`${profile.displayName ?? ''} ${profile.bio ?? ''} ${profile.profileText}`);
  const cityMatch = city ? normalizedProfile.includes(normalizeName(city)) : false;
  const categoryMatch = /restaurant|pizzaria|hamburg|food|bar|cafe|cafeteria|comida|lanchonete/i.test(`${profile.displayName ?? ''} ${profile.bio ?? ''} ${profile.profileText}`);
  return matchingWords.length >= 2 || (matchingWords.length >= 1 && (nameScore >= 0.5 || cityMatch || categoryMatch)) ? matchingWords.length * 30 + (cityMatch ? 20 : 0) + (categoryMatch ? 15 : 0) : 0;
}

async function profileExists(page: Page, username: string, businessName: string, city: string | null) {
  const profile = await scrapeInstagramProfile(page, username);
  if (!profile || profile.isPrivate) return null;
  return profileMatchScore(profile, businessName, city) >= 45 ? profile : null;
}

export async function enrichLeadWithInstagram(
  page: Page,
  lead: typeof leads.$inferSelect,
): Promise<{ updated: boolean; profile: InstagramProfileData | null; method: string | null }> {
  let profile: InstagramProfileData | null = null;
  let method: string | null = null;

  if (lead.instagramUsername) {
    profile = await scrapeInstagramProfile(page, lead.instagramUsername);
    method = profile ? 'existing_username' : null;
  }

  if (!profile && lead.website) {
    const fromWebsite = await findInstagramOnWebsite(lead.website);
    if (fromWebsite) {
      profile = await profileExists(page, fromWebsite, lead.businessName, lead.city);
      method = profile ? 'website' : method;
    }
  }

  if (!profile) {
    for (const guess of guessInstagramUsernames(lead.businessName).slice(0, 4)) {
      profile = await profileExists(page, guess, lead.businessName, lead.city);
      if (profile) {
        method = 'username_guess';
        break;
      }
      await page.waitForTimeout(800);
    }
  }

  if (!profile) {
    const searched = await searchInstagramUsername(page, lead.businessName, lead.city);
    if (searched) {
      profile = await profileExists(page, searched, lead.businessName, lead.city);
      method = profile ? 'instagram_search' : method;
    }
  }

  if (!profile) return { updated: false, profile: null, method: null };

  const bioLower = (profile.bio ?? '').toLowerCase();
  const now = new Date();
  const patch = {
    instagramUsername: profile.username,
    instagramUrl: `https://www.instagram.com/${profile.username}/`,
    followers: profile.followers,
    instagramActive: profile.isActive,
    notes: lead.notes ?? (profile.bio ? `Bio IG: ${profile.bio}` : null),
    category: lead.category ?? profile.category,
    hasDelivery: lead.hasDelivery ?? /delivery|ifood|rappi|entrega/i.test(bioLower) ? true : lead.hasDelivery,
    hasDiningRoom: lead.hasDiningRoom ?? /sal[aã]o|mesa|garçom|garcom|rod[ií]zio/i.test(bioLower) ? true : lead.hasDiningRoom,
    hasWaiters: lead.hasWaiters ?? /garçom|garcom|sal[aã]o/i.test(bioLower) ? true : lead.hasWaiters,
    updatedAt: now,
  };

  await db.update(leads).set(patch).where(eq(leads.id, lead.id));
  await db.insert(activities).values({
    id: crypto.randomUUID(),
    leadId: lead.id,
    type: 'NOTE',
    channel: 'INSTAGRAM',
    content: `[ENRICHMENT] Instagram @${profile.username} encontrado via ${method}. Seguidores: ${profile.followers ?? '?'}. Bio: ${profile.bio ?? '—'}`,
    metadata: JSON.stringify({ method, profile }),
    createdAt: now,
  });

  return { updated: true, profile, method };
}
