'use server';

import { db } from '@/db';
import { settings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import crypto from 'crypto';
import { z } from 'zod';
import { importManualLeadsCsv } from '@/lib/prospecting-sources';
import { requirePermission, AuthError, ForbiddenError } from '@/lib/auth-helpers';
import { logAudit } from '@/lib/audit-log';

const SettingsSchema = z.object({
  name: z.string().trim().optional(),
  commercialName: z.string().trim().optional(),
  instagram: z.string().trim().optional(),
  whatsapp: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.string().trim().email('E-mail invalido').optional().or(z.literal('')),
  city: z.string().trim().optional(),
  territory: z.string().trim().optional(),
  representedCompany: z.string().trim().optional(),
  role: z.string().trim().optional(),
  institutionalText: z.string().trim().optional(),
  aiAnalysisModel: z.string().trim().optional(),
  aiMessageModel: z.string().trim().optional(),
  dailyQueueSize: z.coerce.number().int().min(1).max(50).optional(),
  minScoreForQueue: z.coerce.number().int().min(0).max(100).optional(),
  prospectingCities: z.string().trim().optional(),
  prospectingSegments: z.string().trim().optional(),
  prospectingSearchTerms: z.string().trim().optional(),
  prospectingSources: z.string().trim().optional(),
  maxProfilesPerRun: z.coerce.number().int().min(1).max(200).optional(),
  maxApprovedLeadsPerDay: z.coerce.number().int().min(1).max(100).optional(),
  minActionIntervalSeconds: z.coerce.number().int().min(15).max(3600).optional(),
  ignorePrivateProfiles: z.coerce.boolean().optional(),
  ignoreAlreadyAnalyzed: z.coerce.boolean().optional(),
  ignoreExistingLeads: z.coerce.boolean().optional(),
  ignoreAlreadyContacted: z.coerce.boolean().optional(),
  ignoreDuplicates: z.coerce.boolean().optional(),
  prospectionDryRun: z.coerce.boolean().optional(),
  autoReplyEnabled: z.coerce.boolean().optional(),
  followUpDays: z.coerce.number().int().min(1).max(30).optional(),
  maxFollowUps: z.coerce.number().int().min(0).max(10).optional(),
  operationalMode: z.enum(['ASSISTIDO', 'SEMIAUTOMATICO']).optional(),
});

function listToJson(value: string | undefined) {
  const items = (value ?? '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  return JSON.stringify(Array.from(new Set(items)));
}

export async function saveSettingsAction(formData: FormData) {
  try {
    const user = await requirePermission('SETTINGS_EDIT');

    const csvFile = formData.get('manualLeadCsv');
    const hasCsv = csvFile instanceof File && csvFile.size > 0;
    if (hasCsv) {
      // Importar leads por CSV é uma permissão separada — quem só pode
      // editar configurações gerais não necessariamente pode importar leads
      // em massa.
      await requirePermission('LEADS_IMPORT_CSV');
    }

    const raw = Object.fromEntries(formData.entries()) as Record<string, FormDataEntryValue>;
    raw.prospectingSources = formData.getAll('prospectingSources').map(String).join(',');
    delete raw.manualLeadCsv;
    const parsed = SettingsSchema.safeParse(raw);

    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      return { success: false, error: `${firstError.path.join('.')}: ${firstError.message}` };
    }

    const data = {
      ...parsed.data,
      prospectingCities: listToJson(parsed.data.prospectingCities),
      prospectingSegments: listToJson(parsed.data.prospectingSegments),
      prospectingSearchTerms: listToJson(parsed.data.prospectingSearchTerms),
      prospectingSources: listToJson(parsed.data.prospectingSources),
      ignorePrivateProfiles: parsed.data.ignorePrivateProfiles ?? false,
      ignoreAlreadyAnalyzed: parsed.data.ignoreAlreadyAnalyzed ?? false,
      ignoreExistingLeads: parsed.data.ignoreExistingLeads ?? false,
      ignoreAlreadyContacted: parsed.data.ignoreAlreadyContacted ?? false,
      ignoreDuplicates: parsed.data.ignoreDuplicates ?? false,
      prospectionDryRun: parsed.data.prospectionDryRun ?? false,
      autoReplyEnabled: parsed.data.autoReplyEnabled ?? false,
      operationalMode: parsed.data.operationalMode ?? 'ASSISTIDO',
    };

    const existing = await db.select().from(settings).limit(1);

    if (existing.length > 0) {
      await db.update(settings).set(data).where(eq(settings.id, existing[0].id));
    } else {
      await db.insert(settings).values({ id: crypto.randomUUID(), ...data });
    }

    let csvImportSummary: { created: number; errors: number } | null = null;
    if (hasCsv && csvFile instanceof File) {
      const csvResult = await importManualLeadsCsv(await csvFile.text());
      if (csvResult.errors.length > 0 && csvResult.created === 0) {
        return { success: false, error: csvResult.errors[0] };
      }
      csvImportSummary = { created: csvResult.created, errors: csvResult.errors.length };
    }

    await logAudit({
      userId: user.id,
      userName: user.name,
      action: 'SETTINGS_UPDATED',
      category: 'SETTINGS',
      description: csvImportSummary
        ? `Atualizou as configurações e importou leads via CSV (${csvImportSummary.created} criado(s)).`
        : 'Atualizou as configurações.',
      metadata: csvImportSummary ? { csvImport: csvImportSummary } : undefined,
    });

    revalidatePath('/settings');
    return { success: true };
  } catch (error: any) {
    if (error instanceof AuthError || error instanceof ForbiddenError) {
      return { success: false, error: error.message };
    }
    console.error('Error saving settings:', error);
    return { success: false, error: 'Nao foi possivel salvar as configuracoes.' };
  }
}
