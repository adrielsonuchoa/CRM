import { NextRequest, NextResponse } from 'next/server';
import { AuthError, ForbiddenError, requirePermission } from '@/lib/auth-helpers';
import { ScraperUnavailableError } from '@/lib/google-maps-scraper';
import { GoogleMapsSearchSchema, checkGoogleMapsSearch, startGoogleMapsSearch } from '@/lib/google-maps-prospecting';

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
    const parsed = GoogleMapsSearchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues.map((issue) => issue.message).join(' ') }, { status: 400 });
    }
    const { jobId, keyword } = await startGoogleMapsSearch(parsed.data, user);
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
    const check = await checkGoogleMapsSearch(jobId, user);
    if (check.status === 'failed') {
      return NextResponse.json({ ...check, error: 'A busca falhou no Google Maps Scraper.' }, { status: 502 });
    }
    return NextResponse.json(check, { status: check.status === 'ok' ? 200 : 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
