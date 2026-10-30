import crypto from 'crypto';
import { db } from '@/db';
import { activities, leads } from '@/db/schema';
import { CACHE_TTL, cached } from '@/lib/cache';

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

  const raw = String(value).trim();
  if (!raw) return null;

  const withoutAt = raw.replace(/^@/, '');
  const withoutBaseUrl = withoutAt
    .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '')
    .replace(/^https?:\/\/(?:www\.)?instagram\.com$/i, '');
  const username = withoutBaseUrl.split(/[/?#]/)[0].trim();
  if (!username || ['p', 'reel', 'reels', 'explore', 'accounts', 'direct'].includes(username.toLowerCase())) return null;
  return /^[a-z0-9._]+$/.test(username) ? username.toLowerCase() : null;
}

export async function findInstagramOnWebsite(website: string | null | undefined) {
  if (!website) return null;
  try {
    // Site que respondeu (com ou sem @ no HTML) fica em cache; falha de rede
    // sobe como erro e nao e cacheada, pra tentar de novo na proxima.
    return await cached('website-instagram', [website], async () => {
      const response = await fetch(website, { signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'Sirrus CRM public website lookup' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const matches = html.match(/https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._%/-]+/gi) ?? [];
      return matches.map(getInstagramUsername).find(Boolean) ?? null;
    }, { ttlSeconds: CACHE_TTL.WEEK });
  } catch {
    return null;
  }
}

// Indice em memoria pra checar duplicidade sem um SELECT * na tabela
// inteira por candidato (o que existia antes escalava O(candidatos x
// leads)). Montado uma vez por execucao de discoverGeoapifyPlaces /
// importManualLeadsCsv e alimentado a cada lead novo criado nessa mesma
// execucao, pra tambem pegar duplicatas dentro do proprio lote.
type LeadDuplicateIndex = {
  placeIds: Set<string>;
  phones: Set<string>;
  domains: Set<string>;
  nameAddress: Set<string>;
};

async function buildLeadDuplicateIndex(): Promise<LeadDuplicateIndex> {
  const rows = await db.select({
    placeId: leads.placeId,
    googlePlaceId: leads.googlePlaceId,
    phone: leads.phone,
    websiteDomain: leads.websiteDomain,
    businessName: leads.businessName,
    address: leads.address,
  }).from(leads);

  const index: LeadDuplicateIndex = {
    placeIds: new Set(),
    phones: new Set(),
    domains: new Set(),
    nameAddress: new Set(),
  };
  for (const row of rows) {
    if (row.placeId) index.placeIds.add(row.placeId);
    if (row.googlePlaceId) index.placeIds.add(row.googlePlaceId);
    const phone = normalizePhone(row.phone);
    if (phone) index.phones.add(phone);
    if (row.websiteDomain) index.domains.add(row.websiteDomain);
    const name = normalize(row.businessName);
    const address = normalize(row.address);
    if (name && address) index.nameAddress.add(`${name}|${address}`);
  }
  return index;
}

function isDuplicatePlace(
  index: LeadDuplicateIndex,
  place: { place_id?: string; name?: string; formatted?: string; contact?: { phone?: string } },
  websiteDomain: string | null,
): boolean {
  const placeId = place.place_id;
  const phone = normalizePhone(place.contact?.phone);
  const name = normalize(place.name);
  const address = normalize(place.formatted);

  return Boolean(
    (placeId && index.placeIds.has(placeId)) ||
    (phone && index.phones.has(phone)) ||
    (websiteDomain && index.domains.has(websiteDomain)) ||
    (name && address && index.nameAddress.has(`${name}|${address}`)),
  );
}

function rememberLeadInIndex(index: LeadDuplicateIndex, lead: {
  placeId?: string | null; phone?: string | null; websiteDomain?: string | null;
  businessName?: string | null; address?: string | null;
}): void {
  if (lead.placeId) index.placeIds.add(lead.placeId);
  const phone = normalizePhone(lead.phone);
  if (phone) index.phones.add(phone);
  if (lead.websiteDomain) index.domains.add(lead.websiteDomain);
  const name = normalize(lead.businessName);
  const address = normalize(lead.address);
  if (name && address) index.nameAddress.add(`${name}|${address}`);
}

async function createGeoapifyLead(place: GeoapifyPlace, city: string | null, segment: string | null, term: string, index: LeadDuplicateIndex) {
  const businessName = place.name?.trim();
  if (!businessName) return { leadId: null, duplicate: false, invalid: true };
  const website = place.website ?? place.contact?.website ?? null;
  const websiteDomain = getDomain(website);
  if (isDuplicatePlace(index, place, websiteDomain)) return { leadId: null, duplicate: true };

  const instagramUsername = await findInstagramOnWebsite(website);
  const raw = place.datasource?.raw ?? {};
  const rating = typeof place.rating === 'number' ? place.rating : typeof raw.rating === 'number' ? raw.rating : null;
  const reviewCount = typeof place.reviews === 'number' ? place.reviews : typeof raw.reviews === 'number' ? raw.reviews : null;
  const address = place.formatted ?? ([place.address_line1, place.address_line2].filter(Boolean).join(', ') || null);
  const neighborhood = place.suburb ?? place.neighbourhood ?? place.district ?? place.city_district ?? place.county ?? null;
  const now = new Date();
  const leadId = crypto.randomUUID();
  try {
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
  } catch (err: any) {
    // A busca automatica de fundo e uma busca direcionada podem descobrir o
    // MESMO lugar quase ao mesmo tempo, cada uma com seu proprio indice de
    // duplicidade (montado uma vez no inicio da execucao) - nenhuma das duas
    // ve a insercao da outra a tempo. O indice unico (telefone/instagram) e
    // quem pega essa corrida de verdade; sem isso aqui, esse unico lead
    // duplicado derrubava a execucao inteira em vez de so ser pulado.
    if (String(err?.message ?? '').includes('UNIQUE constraint failed')) {
      return { leadId: null, duplicate: true };
    }
    throw err;
  }
  await db.insert(activities).values({
    id: crypto.randomUUID(),
    leadId,
    type: 'LEAD_CREATED',
    channel: 'GEOAPIFY',
    content: `[GEOAPIFY] Perfil encontrado em: ${term}`,
    metadata: JSON.stringify({ source: 'GEOAPIFY', placeId: place.place_id, term }),
    createdAt: now,
  });
  rememberLeadInIndex(index, { placeId: place.place_id ?? null, phone: place.contact?.phone ?? null, websiteDomain, businessName, address });
  return { leadId, duplicate: false };
}

// Tamanho de página usado nas requisições ao Geoapify. O plano usado neste
// projeto aceita até 20 resultados por chamada.
const GEOAPIFY_PAGE_SIZE = 20;
// Quantas páginas (de GEOAPIFY_PAGE_SIZE resultados cada) podemos avançar por
// termo de busca antes de desistir daquele termo. Isso limita o custo/tempo
// de uma execução mesmo que o termo tenha centenas de resultados e o CRM já
// conheça os primeiros de todos eles.
const GEOAPIFY_MAX_PAGES_PER_TERM = 15;

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
  const duplicateIndex = await buildLeadDuplicateIndex();

  // Coordenadas de uma cidade nao mudam: so pede ao Geoapify uma vez por mes.
  const geocode = await cached('geoapify-geocode', [city ?? 'Brasil'], async () => {
    const geocodeResponse = await fetch(`https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(city ?? 'Brasil')}&format=json&limit=1&apiKey=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(20000),
    }).catch((error) => ({ ok: false, status: 0, json: async () => ({ results: [], error: { message: error?.message ?? 'Falha de rede' } }) }));
    const geocodeData = await geocodeResponse.json() as { results?: Array<{ lat?: number; lon?: number }>; error?: { message?: string } };
    const first = geocodeData.results?.[0];
    if (!geocodeResponse.ok || typeof first?.lat !== 'number' || typeof first.lon !== 'number') {
      return { error: geocodeData.error?.message ?? 'cidade não localizada.' };
    }
    return { lat: first.lat, lon: first.lon };
  }, { ttlSeconds: CACHE_TTL.MONTH, shouldCache: (value) => !('error' in value) });
  if ('error' in geocode) {
    return { leadIds, found, created: leadIds.length, duplicates, errors: [`Geoapify geocoding: ${geocode.error}`] };
  }
  const coordinates = geocode;

  // Antes: a condição de parada (`found >= limit`) contava TODO resultado
  // devolvido pelo Geoapify, inclusive os que já existiam no CRM
  // (duplicados). E cada chamada pedia sempre os resultados a partir do
  // início (sem `offset`), então toda execução repetia exatamente os mesmos
  // estabelecimentos mais bem rankeados — que, depois das primeiras
  // execuções, já eram todos duplicados. Resultado: aumentar o "limite de
  // busca" nas configurações não tinha efeito nenhum, porque o loop nunca
  // avançava para além da primeira página de cada termo.
  //
  // Agora: paginamos de verdade via `offset` (suportado pela Places API do
  // Geoapify) até encontrar leads novos suficientes para atingir `limit`,
  // até esgotar os resultados do termo, ou até um limite de segurança de
  // páginas por termo (GEOAPIFY_MAX_PAGES_PER_TERM).
  for (const term of terms) {
    if (leadIds.length >= limit) break;
    const category = /pizzaria|hamburgueria|restaurante/i.test(term)
      ? 'catering.restaurant'
      : /cafeteria|cafe/i.test(term)
        ? 'catering.cafe'
        : /bar/i.test(term)
          ? 'catering.bar'
          : 'catering.restaurant,catering.cafe,catering.bar';

    let offset = 0;
    for (let page = 0; page < GEOAPIFY_MAX_PAGES_PER_TERM && leadIds.length < limit; page++) {
      const params = new URLSearchParams({
        categories: category,
        filter: `circle:${coordinates.lon},${coordinates.lat},20000`,
        bias: `proximity:${coordinates.lon},${coordinates.lat}`,
        limit: String(GEOAPIFY_PAGE_SIZE),
        offset: String(offset),
        apiKey,
      });
      // Mesma pagina (categoria + coordenadas + offset) nao e pedida de novo
      // por 3 dias - a deduplicacao contra o banco continua rodando em cima.
      // A chave nao inclui a apiKey.
      const pageResult = await cached('geoapify-places', [category, coordinates.lon, coordinates.lat, GEOAPIFY_PAGE_SIZE, offset], async () => {
        const response = await fetch(`https://api.geoapify.com/v2/places?${params.toString()}`, {
          signal: AbortSignal.timeout(20000),
        }).catch((error) => ({ ok: false, status: 0, json: async () => ({ features: [], error: { message: error?.message ?? 'Falha de rede' } }) }));

        const data = await response.json() as { features?: Array<{ properties?: GeoapifyPlace }>; error?: { message?: string } };
        if (!response.ok) return { error: data.error?.message ?? `HTTP ${response.status}` };
        return { features: data.features ?? [] };
      }, { ttlSeconds: 3 * CACHE_TTL.DAY, shouldCache: (value) => !('error' in value) });
      if ('error' in pageResult) {
        errors.push(`Geoapify (${term}): ${pageResult.error}`);
        break;
      }

      const features = pageResult.features;
      if (features.length === 0) break; // sem mais resultados para este termo

      for (const feature of features) {
        if (leadIds.length >= limit) break;
        found++;
        const result = await createGeoapifyLead(feature.properties ?? {}, city, segments[0] ?? null, term, duplicateIndex);
        if (result.duplicate) duplicates++;
        if (result.leadId) leadIds.push(result.leadId);
        if (result.invalid) errors.push(`Geoapify (${term}): resultado sem nome ignorado.`);
      }

      offset += features.length;
      if (features.length < GEOAPIFY_PAGE_SIZE) break; // última página deste termo
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
  const duplicateIndex = await buildLeadDuplicateIndex();
  for (const [lineNumber, line] of lines.slice(1).entries()) {
    const cells = parseCsvLine(line);
    const name = cells[nameIndex]?.trim();
    if (!name) { errors.push(`Linha ${lineNumber + 2}: nome ausente.`); continue; }
    const phone = cells[indexOf('telefone', 'phone')]?.trim() || null;
    const website = cells[indexOf('website', 'site')]?.trim() || null;
    const domain = getDomain(website);
    const cityCell = cells[indexOf('cidade', 'city')]?.trim();
    if (isDuplicatePlace(duplicateIndex, { name, formatted: cityCell, contact: { phone: phone ?? undefined } }, domain)) { duplicates++; continue; }
    const instagram = cells[indexOf('instagram', 'instagramusername')]?.trim().replace(/^@/, '') || null;
    const now = new Date();
    const leadId = crypto.randomUUID();
    try {
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
    } catch (err: any) {
      // Mesma corrida possivel entre a busca de fundo e esta importacao (ver
      // comentario equivalente em createGeoapifyLead) - um telefone/instagram
      // ja usado por outro lead nao pode derrubar o restante do CSV.
      if (String(err?.message ?? '').includes('UNIQUE constraint failed')) { duplicates++; continue; }
      throw err;
    }
    await db.insert(activities).values({ id: crypto.randomUUID(), leadId, type: 'LEAD_CREATED', channel: 'MANUAL', content: '[CSV] Lead importado manualmente', createdAt: now });
    rememberLeadInIndex(duplicateIndex, { placeId: null, phone, websiteDomain: domain, businessName: name, address: cityCell ?? null });
    leadIds.push(leadId);
  }
  return { leadIds, found: lines.length - 1, created: leadIds.length, duplicates, errors };
}
