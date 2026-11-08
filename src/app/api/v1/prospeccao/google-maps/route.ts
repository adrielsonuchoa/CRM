import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, ForbiddenError, requirePermission } from '@/lib/auth-helpers';
import { logAudit } from '@/lib/audit-log';
import { CACHE_TTL, cached, getCachedValue, setCachedValue } from '@/lib/cache';
import {
  ScraperUnavailableError,
  createScraperJob,
  downloadScraperCsv,
  getScraperJobStatus,
  importScrapedPlaces,
  parseScraperCsv,
  type GoogleMapsSearch,
} from '@/lib/google-maps-scraper';

// Prospeccao via Google Maps Scraper (gosom/google-maps-scraper).
//
//   POST /api/v1/prospeccao/google-maps   { cidade, bairro?, nicho }
//     -> 202 { jobId }   (a busca roda no scraper e leva alguns minutos)
//   GET  /api/v1/prospeccao/google-maps?jobId=...
//     -> 202 enquanto roda; 200 com o resumo da importacao quando termina.
//
// O resultado e gravado na tabela leads (upsert por place_id ou telefone) e
// aparece na Fila de Prospeccao, Pipeline e Leads como os demais.

export const dynamic = 'force-dynamic';

const FOOD_NICHE_EXAMPLES = ['restaurante', 'lanchonete', 'bar', 'pizzaria', 'hamburgueria'];

const SearchSchema = z.object({
  cidade: z.string().trim().min(2, 'Informe a cidade.').max(80),
  bairro: z.string().trim().max(80).optional().nullable(),
  nicho: z.string().trim().min(2, `Informe o nicho (ex.: ${FOOD_NICHE_EXAMPLES.join(', ')}).`).max(60),
  maxTempoSegundos: z.coerce.number().int().min(60).max(1800).optional(),
  profundidade: z.coerce.number().int().min(1).max(5).optional(),
});

function errorResponse(error: unknown) {
  if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: 401 });
  if (error instanceof ForbiddenError) return NextResponse.json({ error: error.message }, { status: 403 });
  if (error instanceof ScraperUnavailableError) return NextResponse.json({ error: error.message }, { status: 503 });
  console.error('[GOOGLE-MAPS]', error);
  return NextResponse.json({ error: (error as Error)?.message ?? 'Falha inesperada.' }, { status: 502 });
}

export async function POST(req: NextRequest) {
  try {
    const user = await requirePermission('AUTOMATION_START');
    const parsed = SearchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues.map((issue) => issue.message).join(' ') }, { status: 400 });
    }
    const search: GoogleMapsSearch = parsed.data;
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

    return NextResponse.json({
      jobId,
      keyword,
      status: 'pending',
      acompanhar: `/api/v1/prospeccao/google-maps?jobId=${jobId}`,
    }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await requirePermission('AUTOMATION_START');
    const jobId = req.nextUrl.searchParams.get('jobId')?.trim();
    if (!jobId || !/^[0-9a-f-]{36}$/i.test(jobId)) {
      return NextResponse.json({ error: 'Informe um jobId válido.' }, { status: 400 });
    }

    const status = await getScraperJobStatus(jobId);
    if (status === 'pending' || status === 'working' || status === 'unknown') {
      return NextResponse.json({ jobId, status }, { status: 202 });
    }
    if (status === 'failed') {
      return NextResponse.json({ jobId, status, error: 'A busca falhou no Google Maps Scraper.' }, { status: 502 });
    }

    const params = await getCachedValue<GoogleMapsSearch & { keyword: string }>('gmaps-job', [jobId]);
    // Importacao feita uma vez por job; consultas seguintes devolvem o mesmo
    // resumo (e reimportar seria seguro mesmo assim - e upsert).
    const resultado = await cached('gmaps-import', [jobId], async () => {
      const csv = await downloadScraperCsv(jobId);
      const places = parseScraperCsv(csv, params ?? undefined);
      return importScrapedPlaces(places, {
        nicho: params?.nicho ?? 'Alimentação',
        keyword: params?.keyword ?? `Google Maps job ${jobId}`,
      });
    }, { ttlSeconds: CACHE_TTL.DAY, shouldCache: (value) => value.erros.length === 0 });

    await logAudit({
      userId: user.id,
      userName: user.name,
      action: 'GOOGLE_MAPS_IMPORTED',
      category: 'LEADS',
      description: `Importou busca do Google Maps: ${resultado.criados} novo(s), ${resultado.atualizados} atualizado(s).`,
      metadata: { jobId, criados: resultado.criados, atualizados: resultado.atualizados, ignorados: resultado.ignorados },
    });

    return NextResponse.json({ jobId, status, resultado });
  } catch (error) {
    return errorResponse(error);
  }
}
