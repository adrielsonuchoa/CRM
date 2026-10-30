import crypto from 'crypto';
import { and, count, eq } from 'drizzle-orm';
import { db } from '@/db';
import { leads, settings, tasks } from '@/db/schema';

export const FOLLOW_UP_TASK_TYPE = 'FOLLOW_UP';
export const MANUAL_TASK_TYPE = 'MANUAL';

export const TASK_STATUS = {
  PENDING: 'PENDING',
  DONE: 'DONE',
  CANCELED: 'CANCELED',
} as const;

// Follow-up so faz sentido enquanto o lead foi abordado e ainda nao
// respondeu. Qualquer outro estagio (respondeu, cliente, perdido, nao
// contatar...) cancela os follow-ups pendentes.
export const FOLLOW_UP_STAGE = 'CONTATO REALIZADO';

const DEFAULT_FOLLOW_UP_DAYS = 3;
const DEFAULT_MAX_FOLLOW_UPS = 2;

export function computeFollowUpDueAt(contactAt: Date, followUpDays: number): Date {
  const due = new Date(contactAt);
  due.setDate(due.getDate() + Math.max(1, followUpDays));
  return due;
}

export function followUpTitle(number: number, businessName: string) {
  return `Follow-up ${number} - ${businessName}`;
}

async function getFollowUpSettings() {
  const config = (await db.select({
    followUpDays: settings.followUpDays,
    maxFollowUps: settings.maxFollowUps,
  }).from(settings).limit(1))[0];
  return {
    followUpDays: config?.followUpDays ?? DEFAULT_FOLLOW_UP_DAYS,
    maxFollowUps: config?.maxFollowUps ?? DEFAULT_MAX_FOLLOW_UPS,
  };
}

async function closePendingFollowUps(leadId: string, status: typeof TASK_STATUS.DONE | typeof TASK_STATUS.CANCELED, reason?: string) {
  await db.update(tasks)
    .set({ status, completedAt: new Date(), ...(reason ? { notes: reason } : {}) })
    .where(and(
      eq(tasks.leadId, leadId),
      eq(tasks.type, FOLLOW_UP_TASK_TYPE),
      eq(tasks.status, TASK_STATUS.PENDING),
    ));
}

/**
 * Chame depois de registrar uma mensagem enviada ao lead (DM, WhatsApp,
 * e-mail). Conclui o follow-up pendente (a mensagem enviada E o follow-up)
 * e agenda o proximo, ate o limite de Configuracoes > maxFollowUps.
 * Nunca lanca: falha aqui nao pode desfazer o registro do envio.
 */
export async function scheduleFollowUpAfterContact(leadId: string, contactAt = new Date()) {
  try {
    const lead = (await db.select({
      businessName: leads.businessName,
      pipelineStage: leads.pipelineStage,
      doNotContact: leads.doNotContact,
    }).from(leads).where(eq(leads.id, leadId)).limit(1))[0];
    if (!lead) return;

    await closePendingFollowUps(leadId, TASK_STATUS.DONE);

    if (lead.doNotContact || lead.pipelineStage !== FOLLOW_UP_STAGE) {
      await db.update(leads).set({ nextFollowUpAt: null }).where(eq(leads.id, leadId));
      return;
    }

    const { followUpDays, maxFollowUps } = await getFollowUpSettings();
    const created = (await db.select({ total: count() }).from(tasks).where(and(
      eq(tasks.leadId, leadId),
      eq(tasks.type, FOLLOW_UP_TASK_TYPE),
    )))[0]?.total ?? 0;

    if (created >= maxFollowUps) {
      await db.update(leads).set({ nextFollowUpAt: null }).where(eq(leads.id, leadId));
      return;
    }

    const dueAt = computeFollowUpDueAt(contactAt, followUpDays);
    await db.insert(tasks).values({
      id: crypto.randomUUID(),
      leadId,
      type: FOLLOW_UP_TASK_TYPE,
      title: followUpTitle(created + 1, lead.businessName),
      dueAt,
      status: TASK_STATUS.PENDING,
      createdAt: new Date(),
    });
    await db.update(leads).set({ nextFollowUpAt: dueAt }).where(eq(leads.id, leadId));
  } catch (err: any) {
    console.error('[FOLLOW-UP] Falha ao agendar follow-up:', err?.message ?? err);
  }
}

/**
 * Cancela os follow-ups pendentes do lead (respondeu, mudou de estagio,
 * foi marcado como nao contatar...). Nunca lanca.
 */
export async function cancelPendingFollowUps(leadId: string, reason: string) {
  try {
    await closePendingFollowUps(leadId, TASK_STATUS.CANCELED, reason);
    await db.update(leads).set({ nextFollowUpAt: null }).where(eq(leads.id, leadId));
  } catch (err: any) {
    console.error('[FOLLOW-UP] Falha ao cancelar follow-ups:', err?.message ?? err);
  }
}
