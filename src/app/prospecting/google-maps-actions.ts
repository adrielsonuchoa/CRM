'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, ForbiddenError, requirePermission } from '@/lib/auth-helpers';
import { GoogleMapsSearchSchema, checkGoogleMapsSearch, startGoogleMapsSearch } from '@/lib/google-maps-prospecting';
import type { GoogleMapsImportResult, ScraperJobStatus } from '@/lib/google-maps-scraper';

// Mesmo fluxo da rota /api/v1/prospeccao/google-maps, para o painel da Fila.

type ActionError = { success: false; error: string };

function toError(error: unknown): ActionError {
  if (error instanceof AuthError || error instanceof ForbiddenError) return { success: false, error: error.message };
  return { success: false, error: (error as Error)?.message ?? 'Falha inesperada.' };
}

export async function startGoogleMapsSearchAction(input: { cidade: string; bairro?: string; nicho: string }):
  Promise<{ success: true; jobId: string; keyword: string } | ActionError> {
  try {
    const user = await requirePermission('AUTOMATION_START');
    const parsed = GoogleMapsSearchSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: parsed.error.issues.map((issue) => issue.message).join(' ') };
    const { jobId, keyword } = await startGoogleMapsSearch(parsed.data, user);
    return { success: true, jobId, keyword };
  } catch (error) {
    return toError(error);
  }
}

export async function checkGoogleMapsSearchAction(jobId: string):
  Promise<{ success: true; status: ScraperJobStatus; resultado?: GoogleMapsImportResult } | ActionError> {
  try {
    const user = await requirePermission('AUTOMATION_START');
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) return { success: false, error: 'Busca inválida.' };
    const check = await checkGoogleMapsSearch(jobId, user);
    if (check.status === 'ok') {
      revalidatePath('/prospecting');
      revalidatePath('/leads');
      return { success: true, status: check.status, resultado: check.resultado };
    }
    return { success: true, status: check.status };
  } catch (error) {
    return toError(error);
  }
}
