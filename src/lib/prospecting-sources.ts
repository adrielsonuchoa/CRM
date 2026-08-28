import crypto from 'crypto';
import { db } from '@/db';
import { activities, leads } from '@/db/schema';
import { eq } from 'drizzle-orm';

type ProspectingSettings = {
  city: string | null;
  prospectingCities: string | null;
  prospectingSegments: string | null;
  prospectingSearchTerms: string | null;
  maxProfilesPerRun: number | null;
};

type GeoapifyPlace = {
  place_id?: string;
  name?: string;
  formatted?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  suburb?: string;
  district?: string;
  neighbourhood?: string;
  city_district?: string;
  county?: string;
  state?: string;
  country?: string;
  lat?: number;
  lon?: number;
  website?: string;
  datasource?: { raw?: Record<string, unknown> };
  contact?: { phone?: string; website?: string };
  categories?: string[];
  googleMapsUri?: string;
  rating?: number;
  reviews?: number;
};

export type DiscoveryResult = {
  leadIds: string[];
  found: number;
  created: number;
  duplicates: number;
  errors: string[];
};

function parseList(value: string | null | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  }
}

function normalize(value: string | null | undefined) {
  return (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizePhone(value: string | null | undefined) {
  return (value ?? '').replace(/\D/g, '');
}

function getDomain(value: string | null | undefined) {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function getGoogleMapsSearchUrl(name: string, address: string | null) {
  if (!address) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${address}`)}`;
}

function getInstagramUsername(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!url.hostname.toLowerCase().includes('instagram.com')) return null;
    const username = url.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '').toLowerCase();
    if (!username || ['p', 'reel', 'reels', 'explore', 'accounts', 'direct'].includes(username)) return null;
    return /^[a-z0-9._]+$/.test(username) ? username : null;
  } catch {
    return null;
  }
}

export async function findInstagramOnWebsite(website: string | null | undefined) {
  if (!website) return null;
  try {
    const response = await fetch(website, { signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'Sirrus CRM public website lookup' } });
    if (!response.ok) return null;
    const html = await response.text();
    const matches = html.match(/https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._%/-]+/gi) ?? [];
    return matches.map(getInstagramUsername).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

async function findDuplicate(place: GeoapifyPlace, websiteDomain: string | null) {
  const existingLeads = await db.select().from(leads);
  const placeId = place.place_id;
  const phone = normalizePhone(place.contact?.phone);
  const name = normalize(place.name);
  const address = normalize(place.formatted);

  return existingLeads.find((lead) => (
    (placeId && (lead.placeId === placeId || lead.googlePlaceId === placeId)) ||
    (phone && normalizePhone(lead.phone) === phone) ||
    (websiteDomain && lead.websiteDomain === websiteDomain) ||
    (name && address && normalize(lead.businessName) === name && normalize(lead.address) === address)
  ));
}

async function createGeoapifyLead(place: GeoapifyPlace, city: string | null, segment: string | null, term: string) {
  const businessName = place.name?.trim();
  if (!businessName) return { leadId: null, duplicate: false, invalid: true };
  const website = place.website ?? place.contact?.website ?? null;
  const websiteDomain = getDomain(website);
  const duplicate = await findDuplicate(place, websiteDomain);
  if (duplicate) return { leadId: null, duplicate: true };

  const instagramUsername = await findInstagramOnWebsite(website);
  const raw = place.datasource?.raw ?? {};
  const rating = typeof place.rating === 'number' ? place.rating : typeof raw.rating === 'number' ? raw.rating : null;
  const reviewCount = typeof place.reviews === 'number' ? place.reviews : typeof raw.reviews === 'number' ? raw.reviews : null;
  const address = place.formatted ?? ([place.address_line1, place.address_line2].filter(Boolean).join(', ') || null);
  const neighborhood = place.suburb ?? place.neighbourhood ?? place.district ?? place.city_district ?? place.county ?? null;
  const now = new Date();
  const leadId = crypto.randomUUID();
  await db.insert(leads).values({
    id: leadId,
    businessName,
    instagramUsername,
    instagramUrl: instagramUsername ? `https://www.instagram.com/${instagramUsername}/` : null,
    placeId: place.place_id ?? null,
    googleMapsUrl: getGoogleMapsSearchUrl(businessName, address),
    phone: place.contact?.phone ?? null,
    website,
    websiteDomain,
    address,
    neighborhood,
    city: place.city ?? city,
    state: place.state ?? null,
    category: segment || place.categories?.[0] || null,
    rating,
    reviewCount,
    source: 'GEOAPIFY',
    qualificationStatus: 'DESCOBERTO',
    pipelineStage: 'DESCOBERTO',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(activities).values({
    id: crypto.randomUUID(),
    leadId,
    type: 'LEAD_CREATED',
    channel: 'GEOAPIFY',
    content: `[GEOAPIFY] Perfil encontrado em: ${term}`,
    metadata: JSON.stringify({ source: 'GEOAPIFY', placeId: place.place_id, term }),
    createdAt: now,
  });
  return { leadId, duplicate: false };
}

export async function discoverGeoapifyPlaces(config: ProspectingSettings): Promise<DiscoveryResult> {
  const apiKey = process.env.GEOAPIFY_API_KEY?.trim();
  if (!apiKey) return { leadIds: [], found: 0, created: 0, duplicates: 0, errors: ['GEOAPIFY_API_KEY não configurada.'] };

  const cities = parseList(config.prospectingCities);
  const city = cities[0] ?? config.city ?? null;
  const segments = parseList(config.prospectingSegments);
  const configuredTerms = parseList(config.prospectingSearchTerms);
  const terms = configuredTerms.length > 0
    ? configuredTerms.map((term) => /\b(em|in|maceio|maceió|alagoas|al)\b/i.test(term) ? term : `${term} em ${city ?? ''}`.trim())
    : segments.map((segment) => `${segment} em ${city ?? ''}`.trim());
  const limit = Math.min(Math.max(config.maxProfilesPerRun ?? 20, 1), 200);
  const leadIds: string[] = [];
  const errors: string[] = [];
  let found = 0;
  let duplicates = 0;

  const geocodeResponse = await fetch(`https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(city ?? 'Brasil')}&format=json&limit=1&apiKey=${encodeURIComponent(apiKey)}`, {
    signal: AbortSignal.timeout(20000),
  }).catch((error) => ({ ok: false, status: 0, json: async () => ({ results: [], error: { message: error?.message ?? 'Falha de rede' } }) }));
  const geocodeData = await geocodeResponse.json() as { results?: Array<{ lat?: number; lon?: number }>; error?: { message?: string } };
  const coordinates = geocodeData.results?.[0];
  if (!geocodeResponse.ok || typeof coordinates?.lat !== 'number' || typeof coordinates.lon !== 'number') {
    return { leadIds, found, created: leadIds.length, duplicates, errors: [`Geoapify geocoding: ${geocodeData.error?.message ?? 'cidade não localizada.'}`] };
  }

  for (const term of terms) {
    if (found >= limit) break;
    const category = /pizzaria|hamburgueria|restaurante/i.test(term)
      ? 'catering.restaurant'
      : /cafeteria|cafe/i.test(term)
        ? 'catering.cafe'
        : /bar/i.test(term)
          ? 'catering.bar'
          : 'catering.restaurant,catering.cafe,catering.bar';
    const params = new URLSearchParams({
      categories: category,
      filter: `circle:${coordinates.lon},${coordinates.lat},20000`,
      bias: `proximity:${coordinates.lon},${coordinates.lat}`,
      limit: String(Math.min(limit - found, 20)),
      apiKey,
    });
    const response = await fetch(`https://api.geoapify.com/v2/places?${params.toString()}`, {
      signal: AbortSignal.timeout(20000),
    }).catch((error) => ({ ok: false, status: 0, json: async () => ({ features: [], error: { message: error?.message ?? 'Falha de rede' } }) }));

    const data = await response.json() as { features?: Array<{ properties?: GeoapifyPlace }>; error?: { message?: string } };
    if (!response.ok) {
      errors.push(`Geoapify (${term}): ${data.error?.message ?? `HTTP ${response.status}`}`);
      continue;
    }

    for (const feature of data.features ?? []) {
      if (found >= limit) break;
      found++;
      const result = await createGeoapifyLead(feature.properties ?? {}, city, segments[0] ?? null, term);
      if (result.duplicate) duplicates++;
      if (result.leadId) leadIds.push(result.leadId);
      if (result.invalid) errors.push(`Geoapify (${term}): resultado sem nome ignorado.`);
    }
  }

  return { leadIds, found, created: leadIds.length, duplicates, errors };
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') { cell += '"'; index++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { cells.push(cell.trim()); cell = ''; continue; }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

export async function importManualLeadsCsv(csv: string): Promise<DiscoveryResult> {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { leadIds: [], found: 0, created: 0, duplicates: 0, errors: ['CSV vazio ou sem linhas de dados.'] };
  const headers = parseCsvLine(lines[0]).map((header) => normalize(header));
  const indexOf = (...names: string[]) => names.map(normalize).map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
  const nameIndex = indexOf('nome', 'name');
  if (nameIndex < 0) return { leadIds: [], found: 0, created: 0, duplicates: 0, errors: ['CSV precisa conter a coluna nome.'] };

  const leadIds: string[] = [];
  const errors: string[] = [];
  let duplicates = 0;
  for (const [lineNumber, line] of lines.slice(1).entries()) {
    const cells = parseCsvLine(line);
    const name = cells[nameIndex]?.trim();
    if (!name) { errors.push(`Linha ${lineNumber + 2}: nome ausente.`); continue; }
    const phone = cells[indexOf('telefone', 'phone')]?.trim() || null;
    const website = cells[indexOf('website', 'site')]?.trim() || null;
    const domain = getDomain(website);
    const duplicate = await findDuplicate({ name, formatted: cells[indexOf('cidade', 'city')]?.trim(), contact: { phone: phone ?? undefined } }, domain);
    if (duplicate || (phone && (await db.select().from(leads).where(eq(leads.phone, phone)).limit(1)).length > 0)) { duplicates++; continue; }
    const instagram = cells[indexOf('instagram', 'instagramusername')]?.trim().replace(/^@/, '') || null;
    const now = new Date();
    const leadId = crypto.randomUUID();
    await db.insert(leads).values({
      id: leadId,
      businessName: name,
      instagramUsername: instagram,
      instagramUrl: instagram ? `https://www.instagram.com/${instagram}/` : null,
      phone,
      website,
      websiteDomain: domain,
      city: cells[indexOf('cidade', 'city')]?.trim() || null,
      category: cells[indexOf('segmento', 'segment')]?.trim() || null,
      source: 'MANUAL_CSV',
      qualificationStatus: 'DESCOBERTO',
      pipelineStage: 'DESCOBERTO',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(activities).values({ id: crypto.randomUUID(), leadId, type: 'LEAD_CREATED', channel: 'MANUAL', content: '[CSV] Lead importado manualmente', createdAt: now });
    leadIds.push(leadId);
  }
  return { leadIds, found: lines.length - 1, created: leadIds.length, duplicates, errors };
}
