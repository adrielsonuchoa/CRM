import { z } from 'zod';
import type { CurrentUser } from '@/lib/auth-helpers';
import { logAudit } from '@/lib/audit-log';
import { CACHE_TTL, cached, getCachedValue, setCachedValue } from '@/lib/cache';
import {
  createScraperJob,
  downloadScraperCsv,
  getScraperJobStatus,
  importScrapedPlaces,
  parseScraperCsv,
  type GoogleMapsImportResult,
  type GoogleMapsSearch,
  type ScraperJobStatus,
} from '@/lib/google-maps-scraper';

// Fluxo de prospeccao pelo Google Maps compartilhado pela rota
// /api/v1/prospeccao/google-maps e pelo painel da Fila de Prospeccao.

export const FOOD_NICHES = ['restaurante', 'lanchonete', 'bar', 'pizzaria', 'hamburgueria', 'padaria', 'cafeteria', 'açaí', 'sorveteria', 'self-service'];

export const GoogleMapsSearchSchema = z.object({
  cidade: z.string().trim().min(2, 'Informe a cidade.').max(80),
  bairro: z.string().trim().max(80).optional().nullable(),
  nicho: z.string().trim().min(2, `Informe o nicho (ex.: ${FOOD_NICHES.slice(0, 5).join(', ')}).`).max(60),
  maxTempoSegundos: z.coerce.number().int().min(60).max(1800).optional(),
  profundidade: z.coerce.number().int().min(1).max(5).optional(),
});

export type GoogleMapsSearchCheck =
  | { jobId: string; status: Exclude<ScraperJobStatus, 'ok'> }
  | { jobId: string; status: 'ok'; resultado: GoogleMapsImportResult };

export async function startGoogleMapsSearch(search: GoogleMapsSearch, user: CurrentUser) {
  const { jobId, keyword } = await createScraperJob(search);
  // Guarda os parametros pra importacao (o scraper so devolve a palavra-chave).
  await setCachedValue('gmaps-job', [jobId], { ...search, keyword }, CACHE_TTL.WEEK);
  await logAudit({
    userId: user.id,
    userName: user.name,
    action: 'GOOGLE_MAPS_SEARCH_STARTED',
    category: 'AUTOMATION',
    description: `Iniciou busca no Google Maps: "${keyword}".`,
    metadata: { jobId, keyword },
  });
  return { jobId, keyword };
}

// Consulta o job; quando terminou, importa os leads (uma vez por job - as
// consultas seguintes devolvem o mesmo resumo).
export async function checkGoogleMapsSearch(jobId: string, user: CurrentUser): Promise<GoogleMapsSearchCheck> {
  const status = await getScraperJobStatus(jobId);
  if (status !== 'ok') return { jobId, status };

  const params = await getCachedValue<GoogleMapsSearch & { keyword: string }>('gmaps-job', [jobId]);
  let imported = false;
  const resultado = await cached('gmaps-import', [jobId], async () => {
    imported = true;
    const csv = await downloadScraperCsv(jobId);
    const places = parseScraperCsv(csv, params ?? undefined);
    return importScrapedPlaces(places, {
      nicho: params?.nicho ?? 'Alimentação',
      keyword: params?.keyword ?? `Google Maps job ${jobId}`,
    });
  }, { ttlSeconds: CACHE_TTL.DAY, shouldCache: (value) => value.erros.length === 0 });

  if (imported) {
    await logAudit({
      userId: user.id,
      userName: user.name,
      action: 'GOOGLE_MAPS_IMPORTED',
      category: 'LEADS',
      description: `Importou busca do Google Maps: ${resultado.criados} novo(s), ${resultado.atualizados} atualizado(s).`,
      metadata: { jobId, criados: resultado.criados, atualizados: resultado.atualizados, ignorados: resultado.ignorados },
    });
  }
  return { jobId, status, resultado };
}
