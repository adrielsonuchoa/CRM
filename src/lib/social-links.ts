import { normalizeWhatsAppNumber } from '@/lib/phone';
import { normalizeEmail } from '@/lib/email';

// Extracao de redes sociais/contatos a partir de links e do HTML do site de um
// estabelecimento. Sem banco nem rede - so texto - pra ser testavel e
// reaproveitada pela busca do Geoapify e pela importacao do Google Maps.

export type SocialLinks = {
  instagram: string | null;
  facebook: string | null;
  whatsapp: string | null;
  emails: string[];
};

const INSTAGRAM_RESERVED = ['p', 'reel', 'reels', 'explore', 'accounts', 'direct', 'stories', 'tv', 'about', 'legal'];
const FACEBOOK_RESERVED = ['sharer', 'sharer.php', 'share', 'dialog', 'plugins', 'tr', 'login', 'policies', 'help', 'privacy', 'watch', 'events', 'groups', 'hashtag', 'photo.php', 'story.php'];

export function getInstagramUsername(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const withoutAt = raw.replace(/^@/, '');
  const withoutBaseUrl = withoutAt
    .replace(/^https?:\/\/(?:www\.|m\.)?instagram\.com\//i, '')
    .replace(/^https?:\/\/(?:www\.|m\.)?instagram\.com$/i, '');
  const username = withoutBaseUrl.split(/[/?#]/)[0].trim();
  if (!username || INSTAGRAM_RESERVED.includes(username.toLowerCase())) return null;
  return /^[a-z0-9._]+$/i.test(username) ? username.toLowerCase() : null;
}

// Pagina do Facebook normalizada (https://www.facebook.com/<pagina>). Ignora
// links de compartilhar, pixel, plugins etc.
export function getFacebookPageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (!/(^|\.)(facebook|fb)\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    if (parts[0].toLowerCase() === 'profile.php') {
      const id = url.searchParams.get('id');
      return id && /^\d+$/.test(id) ? `https://www.facebook.com/profile.php?id=${id}` : null;
    }
    const page = parts[0] === 'pages' && parts.length >= 2 ? parts.slice(0, 3).join('/') : parts[0];
    if (FACEBOOK_RESERVED.includes(page.toLowerCase())) return null;
    return /^[a-z0-9.\-/]+$/i.test(page) ? `https://www.facebook.com/${page}` : null;
  } catch {
    return null;
  }
}

// Numero de WhatsApp a partir de links wa.me / api.whatsapp.com.
export function getWhatsAppFromLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    const host = url.hostname.toLowerCase();
    if (host === 'wa.me' || host.endsWith('.wa.me')) {
      return normalizeWhatsAppNumber(url.pathname.split('/').filter(Boolean)[0] ?? '');
    }
    if (host.endsWith('whatsapp.com')) return normalizeWhatsAppNumber(url.searchParams.get('phone'));
    return null;
  } catch {
    return null;
  }
}

// Celular brasileiro (DDD + 9 + 8 digitos) quase sempre e WhatsApp; fixo nao.
export function isBrazilianMobile(phone: string | null | undefined): boolean {
  const normalized = normalizeWhatsAppNumber(phone);
  return !!normalized && normalized.length === 13 && normalized[4] === '9';
}

const URL_PATTERN = /https?:\/\/[^\s"'<>()\\]+/gi;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Extensoes de arquivo que o padrao de e-mail confunde (ex.: logo@2x.png).
const NOT_EMAIL_SUFFIX = /\.(png|jpe?g|gif|webp|svg|css|js)$/i;

export function extractSocialLinksFromHtml(html: string): SocialLinks {
  const urls = (html.match(URL_PATTERN) ?? []).map((url) => url.replace(/&amp;/g, '&'));
  const mailtos = (html.match(/mailto:([^"'?\s>]+)/gi) ?? []).map((m) => m.replace(/^mailto:/i, ''));
  const emails = Array.from(new Set(
    [...mailtos, ...(html.match(EMAIL_PATTERN) ?? [])]
      .filter((email) => !NOT_EMAIL_SUFFIX.test(email))
      .map((email) => normalizeEmail(decodeURIComponent(email)))
      .filter((email): email is string => !!email),
  )).slice(0, 5);

  return {
    instagram: urls.map((url) => (/instagram\.com/i.test(url) ? getInstagramUsername(url) : null)).find(Boolean) ?? null,
    facebook: urls.map(getFacebookPageUrl).find(Boolean) ?? null,
    whatsapp: urls.map(getWhatsAppFromLink).find(Boolean) ?? null,
    emails,
  };
}

// Quando o "site" cadastrado no Google Maps ja e a propria rede social.
export function socialLinksFromWebsiteUrl(website: string | null | undefined): Partial<SocialLinks> {
  if (!website) return {};
  if (/instagram\.com/i.test(website)) return { instagram: getInstagramUsername(website) };
  const facebook = getFacebookPageUrl(website);
  if (facebook) return { facebook };
  const whatsapp = getWhatsAppFromLink(website);
  return whatsapp ? { whatsapp } : {};
}

export function isSocialOrMessagingUrl(website: string | null | undefined) {
  return !!website && /(instagram\.com|facebook\.com|fb\.com|wa\.me|whatsapp\.com|linktr\.ee)/i.test(website);
}
