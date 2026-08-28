'use server';

import { db } from '@/db';
import { settings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import crypto from 'crypto';
import { z } from 'zod';

const SettingsSchema = z.object({
  name: z.string().trim().optional(),
  commercialName: z.string().trim().optional(),
  instagram: z.string().trim().optional(),
  whatsapp: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.string().trim().email('E-mail inválido').optional().or(z.literal('')),
  city: z.string().trim().optional(),
  territory: z.string().trim().optional(),
  representedCompany: z.string().trim().optional(),
  role: z.string().trim().optional(),
  institutionalText: z.string().trim().optional(),
  aiAnalysisModel: z.string().trim().optional(),
  aiMessageModel: z.string().trim().optional(),
  dailyQueueSize: z.coerce.number().int().min(1).max(50).optional(),
  minScoreForQueue: z.coerce.number().int().min(0).max(100).optional(),
  followUpDays: z.coerce.number().int().min(1).max(30).optional(),
  maxFollowUps: z.coerce.number().int().min(0).max(10).optional(),
  operationalMode: z.enum(['ASSISTIDO', 'SEMIAUTOMÁTICO']).optional(),
});

export async function saveSettingsAction(formData: FormData) {
  try {
    const raw = Object.fromEntries(formData.entries());
    const parsed = SettingsSchema.safeParse(raw);

    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      return { success: false, error: `${firstError.path.join('.')}: ${firstError.message}` };
    }

    const data = parsed.data;
    const existing = await db.select().from(settings).limit(1);

    if (existing.length > 0) {
      await db.update(settings).set(data).where(eq(settings.id, existing[0].id));
    } else {
      await db.insert(settings).values({ id: crypto.randomUUID(), ...data });
    }

    revalidatePath('/settings');
    return { success: true };
  } catch (error: any) {
    console.error('Error saving settings:', error);
    return { success: false, error: 'Não foi possível salvar as configurações.' };
  }
}
