import crypto from 'crypto';
import { eq, isNotNull, or } from 'drizzle-orm';
import { db } from '@/db';
import { activities, leads } from '@/db/schema';
import { parseCsvRecords } from '@/lib/csv';
import { normalizeEmail } from '@/lib/email';
import { normalizeWhatsAppNumber } from '@/lib/phone';
import { findSocialLinksOnWebsite } from '@/lib/prospecting-sources';
import { isBrazilianMobile, isSocialOrMessagingUrl, socialLinksFromWebsiteUrl } from '@/lib/social-links';

// Integracao com o Google Maps Scraper (github.com/gosom/google-maps-scraper)
// rodando em modo web (-web), por padrao em http://localhost:8080. A API dele
// trabalha com jobs assincronos: cria (POST /api/v1/jobs) -> acompanha
// (GET /api/v1/jobs/{id}: pending|working|ok|failed) -> baixa o CSV
// (GET /api/v1/jobs/{id}/download).

export type GoogleMapsSearch = {
  cidade: string;
  bairro?: string | null;
  nicho: string;
  maxTempoSegundos?: number;
  profundidade?: number;
};

export type ScraperJobStatus = 'pending' | 'working' | 'ok' | 'failed' | 'unknown';

export type ScrapedPlace = {
  placeId: string | null;
  name: string;
  phone: string | null;
  website: string | null;
  emails: string[];
  address: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  category: string | null;
  rating: number | null;
  reviewCount: number | null;
  googleMapsUrl: string | null;
};

export type GoogleMapsImportResult = {
  encontrados: number;
  criados: number;
  atualizados: number;
  ignorados: number;
  erros: string[];
  leadIds: string[];
};

export class ScraperUnavailableError extends Error {}

export function getScraperBaseUrl() {
  return (process.env.GOOGLE_MAPS_SCRAPER_URL?.trim() || 'http://localhost:8080').replace(/\/+$/, '');
}

export function buildSearchKeyword({ cidade, bairro, nicho }: GoogleMapsSearch) {
  const place = [bairro?.trim(), cidade.trim()].filter(Boolean).join(', ');
  return `${nicho.trim()} em ${place}`;
}

async function scraperFetch(path: string, init?: RequestInit) {
  try {
    return await fetch(`${getScraperBaseUrl()}${path}`, { ...init, signal: AbortSignal.timeout(30000), cache: 'no-store' });
  } catch (err: any) {
    throw new ScraperUnavailableError(`Google Maps Scraper indisponível em ${getScraperBaseUrl()} (${err?.message ?? err}). Verifique se o container/serviço está rodando.`);
  }
}

export async function createScraperJob(search: GoogleMapsSearch): Promise<{ jobId: string; keyword: string }> {
  const keyword = buildSearchKeyword(search);
  const response = await scraperFetch('/api/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `CRM - ${keyword}`.slice(0, 120),
      keywords: [keyword],
      lang: 'pt',
      zoom: 15,
      depth: search.profundidade ?? 1,
      // Visita o site de cada empresa pra extrair e-mails.
      email: true,
      // Em segundos (o scraper multiplica por time.Second).
      max_time: search.maxTempoSegundos ?? 600,
    }),
  });
  const data = await response.json().catch(() => ({})) as { id?: string; message?: string; error?: string };
  if (!response.ok || !data.id) {
    throw new Error(`Google Maps Scraper recusou a busca (HTTP ${response.status}): ${data.message ?? data.error ?? 'sem detalhes'}`);
  }
  return { jobId: data.id, keyword };
}

export async function getScraperJobStatus(jobId: string): Promise<ScraperJobStatus> {
  const response = await scraperFetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
  if (response.status === 404) throw new Error('Busca não encontrada no Google Maps Scraper.');
  if (!response.ok) throw new Error(`Google Maps Scraper respondeu HTTP ${response.status}.`);
  // A struct Job do scraper nao tem json tags: as chaves saem como "Status".
  const data = await response.json() as { Status?: string; status?: string };
  const status = String(data.Status ?? data.status ?? '').toLowerCase();
  return (['pending', 'working', 'ok', 'failed'] as const).find((value) => value === status) ?? 'unknown';
}

export async function downloadScraperCsv(jobId: string): Promise<string> {
  const response = await scraperFetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/download`);
  if (!response.ok) throw new Error(`Não foi possível baixar o resultado (HTTP ${response.status}).`);
  return response.text();
}

function toNumber(value: string | undefined) {
  if (!value) return null;
  const number = Number(value.replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function parseCompleteAddress(value: string | undefined) {
  if (!value) return {} as Record<string, string>;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

// Uma linha do CSV do scraper -> campos do lead. Puro, testavel.
export function mapScraperRecord(record: Record<string, string>, search?: Pick<GoogleMapsSearch, 'cidade' | 'bairro'>): ScrapedPlace | null {
  const name = record.title?.trim();
  if (!name) return null;
  const complete = parseCompleteAddress(record.complete_address);
  const emails = (record.emails ?? '')
    .split(/[,;\s]+/)
    .map((email) => normalizeEmail(email))
    .filter((email): email is string => !!email);
  const reviewCount = toNumber(record.review_count);
  return {
    // place_id e o identificador estavel do Google; data_id/cid ficam de reserva.
    placeId: record.place_id || record.data_id || (record.cid ? `cid:${record.cid}` : null) || null,
    name,
    phone: record.phone?.trim() || null,
    website: record.website?.trim() || null,
    emails: Array.from(new Set(emails)),
    address: record.address?.trim() || null,
    neighborhood: complete.borough?.trim() || search?.bairro?.trim() || null,
    city: complete.city?.trim() || search?.cidade?.trim() || null,
    state: complete.state?.trim() || null,
    category: record.category?.trim() || null,
    rating: toNumber(record.review_rating),
    reviewCount: reviewCount === null ? null : Math.round(reviewCount),
    googleMapsUrl: record.link?.trim() || null,
  };
}

export function parseScraperCsv(csv: string, search?: Pick<GoogleMapsSearch, 'cidade' | 'bairro'>): ScrapedPlace[] {
  return parseCsvRecords(csv).map((record) => mapScraperRecord(record, search)).filter((place): place is ScrapedPlace => !!place);
}

// Chave de telefone pra deduplicar: so os digitos, sem o 55 do Brasil -
// "+55 82 3221-0901" e "(82) 3221-0901" sao o mesmo numero. (O indice UNIQUE
// do banco em leads.phone compara o texto exato e nao pega esse caso.)
export function phoneKey(phone: string | null | undefined) {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 8) return null;
  return digits.startsWith('55') && (digits.length === 12 || digits.length === 13) ? digits.slice(2) : digits;
}

function getDomain(value: string | null) {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

type ExistingLeadRef = { id: string };

async function buildExistingIndex() {
  const rows = await db.select({ id: leads.id, placeId: leads.placeId, googlePlaceId: leads.googlePlaceId, phone: leads.phone, whatsapp: leads.whatsapp })
    .from(leads)
    .where(or(isNotNull(leads.placeId), isNotNull(leads.googlePlaceId), isNotNull(leads.phone), isNotNull(leads.whatsapp)));
  const byPlaceId = new Map<string, ExistingLeadRef>();
  const byPhone = new Map<string, ExistingLeadRef>();
  for (const row of rows) {
    if (row.placeId) byPlaceId.set(row.placeId, row);
    if (row.googlePlaceId) byPlaceId.set(row.googlePlaceId, row);
    for (const phone of [row.phone, row.whatsapp]) {
      const key = phoneKey(phone);
      if (key && !byPhone.has(key)) byPhone.set(key, row);
    }
  }
  return { byPlaceId, byPhone };
}

// Grava os estabelecimentos na tabela leads: lead novo quando nao existe;
// quando ja existe (mesmo place_id ou mesmo telefone), ATUALIZA - completa
// campos vazios e renova nota/avaliacoes, sem mexer em estagio, notas nem em
// dados ja preenchidos pelo usuario.
export async function importScrapedPlaces(places: ScrapedPlace[], context: { nicho: string; keyword: string }): Promise<GoogleMapsImportResult> {
  const result: GoogleMapsImportResult = { encontrados: places.length, criados: 0, atualizados: 0, ignorados: 0, erros: [], leadIds: [] };
  const index = await buildExistingIndex();
  const seenInBatch = new Set<string>();

  for (const place of places) {
    try {
      const phoneMatchKey = phoneKey(place.phone);
      const batchKey = place.placeId ?? phoneMatchKey ?? place.name.toLowerCase();
      if (seenInBatch.has(batchKey)) { result.ignorados++; continue; }
      seenInBatch.add(batchKey);

      // Redes sociais: o proprio "site" pode ser o Instagram/Facebook; senao
      // le o site (com cache) atras de Instagram, Facebook, WhatsApp e e-mail.
      const fromUrl = socialLinksFromWebsiteUrl(place.website);
      const fromSite = place.website && !isSocialOrMessagingUrl(place.website) ? await findSocialLinksOnWebsite(place.website) : null;
      const instagram = fromUrl.instagram ?? fromSite?.instagram ?? null;
      const facebook = fromUrl.facebook ?? fromSite?.facebook ?? null;
      const whatsapp = fromUrl.whatsapp ?? fromSite?.whatsapp ?? (isBrazilianMobile(place.phone) ? normalizeWhatsAppNumber(place.phone) : null);
      const email = place.emails[0] ?? fromSite?.emails[0] ?? null;
      const website = place.website && !isSocialOrMessagingUrl(place.website) ? place.website : null;
      const now = new Date();

      const existing = (place.placeId ? index.byPlaceId.get(place.placeId) : undefined)
        ?? (phoneMatchKey ? index.byPhone.get(phoneMatchKey) : undefined)
        ?? (whatsapp ? index.byPhone.get(phoneKey(whatsapp) ?? '') : undefined);

      if (existing) {
        const current = (await db.select().from(leads).where(eq(leads.id, existing.id)).limit(1))[0];
        if (!current) { result.ignorados++; continue; }
        await db.update(leads).set({
          placeId: current.placeId ?? place.placeId,
          googleMapsUrl: place.googleMapsUrl ?? current.googleMapsUrl,
          phone: current.phone ?? place.phone,
          whatsapp: current.whatsapp ?? whatsapp,
          email: current.email ?? email,
          website: current.website ?? website,
          websiteDomain: current.websiteDomain ?? getDomain(website),
          instagramUsername: current.instagramUsername ?? instagram,
          instagramUrl: current.instagramUrl ?? (instagram ? `https://www.instagram.com/${instagram}/` : null),
          facebookUrl: current.facebookUrl ?? facebook,
          address: current.address ?? place.address,
          neighborhood: current.neighborhood ?? place.neighborhood,
          city: current.city ?? place.city,
          state: current.state ?? place.state,
          category: current.category ?? context.nicho,
          subcategory: current.subcategory ?? place.category,
          rating: place.rating ?? current.rating,
          reviewCount: place.reviewCount ?? current.reviewCount,
          updatedAt: now,
        }).where(eq(leads.id, existing.id));
        result.atualizados++;
        result.leadIds.push(existing.id);
        continue;
      }

      const leadId = crypto.randomUUID();
      try {
        await db.insert(leads).values({
          id: leadId,
          businessName: place.name,
          placeId: place.placeId,
          googleMapsUrl: place.googleMapsUrl,
          phone: place.phone,
          whatsapp,
          email,
          website,
          websiteDomain: getDomain(website),
          instagramUsername: instagram,
          instagramUrl: instagram ? `https://www.instagram.com/${instagram}/` : null,
          facebookUrl: facebook,
          address: place.address,
          neighborhood: place.neighborhood,
          city: place.city,
          state: place.state,
          category: context.nicho,
          subcategory: place.category,
          rating: place.rating,
          reviewCount: place.reviewCount,
          source: 'GOOGLE_MAPS',
          qualificationStatus: 'DESCOBERTO',
          pipelineStage: 'DESCOBERTO',
          createdAt: now,
          updatedAt: now,
        });
      } catch (err: any) {
        // Corrida com outra importacao/busca: o indice UNIQUE (place_id,
        // telefone, instagram) pegou o duplicado - so pula.
        if (String(err?.message ?? err).includes('UNIQUE')) { result.ignorados++; continue; }
        throw err;
      }
      await db.insert(activities).values({
        id: crypto.randomUUID(),
        leadId,
        type: 'LEAD_CREATED',
        channel: 'GOOGLE_MAPS',
        content: `[GOOGLE MAPS] Encontrado em: ${context.keyword}`,
        metadata: JSON.stringify({ source: 'GOOGLE_MAPS', placeId: place.placeId, keyword: context.keyword }),
        createdAt: now,
      });
      if (place.placeId) index.byPlaceId.set(place.placeId, { id: leadId });
      for (const phone of [place.phone, whatsapp]) {
        const key = phoneKey(phone);
        if (key) index.byPhone.set(key, { id: leadId });
      }
      result.criados++;
      result.leadIds.push(leadId);
    } catch (err: any) {
      result.erros.push(`${place.name}: ${err?.message ?? err}`);
    }
  }
  return result;
}
