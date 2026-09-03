'use server';

import { db } from '@/db';
import { leads, activities } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import crypto from 'crypto';
import { requirePermission, AuthError, ForbiddenError } from '@/lib/auth-helpers';
import { logAudit } from '@/lib/audit-log';

// Erros de autenticação/permissão viram uma resposta amigável ({success:
// false, error}) em vez de estourar um erro genérico pro usuário — mas o
// bloqueio em si acontece antes de qualquer leitura/escrita no banco.
function authErrorMessage(error: unknown): string | null {
  if (error instanceof AuthError || error instanceof ForbiddenError) return error.message;
  return null;
}

export async function updateLeadStage(leadId: string, newStage: string) {
  try {
    const user = await requirePermission('LEAD_UPDATE_STAGE');

    const existing = await db.select({ pipelineStage: leads.pipelineStage }).from(leads).where(eq(leads.id, leadId)).limit(1);
    const oldStage = existing[0]?.pipelineStage ?? 'NOVO';

    await db.update(leads)
      .set({ pipelineStage: newStage, updatedAt: new Date() })
      .where(eq(leads.id, leadId));

    await db.insert(activities).values({
      id: crypto.randomUUID(),
      leadId,
      type: 'PIPELINE_CHANGED',
      content: `Pipeline atualizado: ${oldStage} → ${newStage}`,
      metadata: JSON.stringify({ from: oldStage, to: newStage }),
      createdAt: new Date(),
    });

    await logAudit({
      userId: user.id,
      userName: user.name,
      action: 'LEAD_STAGE_CHANGED',
      category: 'PIPELINE',
      entityType: 'LEAD',
      entityId: leadId,
      description: `Moveu o lead no pipeline: ${oldStage} → ${newStage}.`,
      metadata: { from: oldStage, to: newStage },
    });

    revalidatePath('/pipeline');
    revalidatePath('/');
    revalidatePath(`/leads/${leadId}`);
    return { success: true };
  } catch (error) {
    const authMessage = authErrorMessage(error);
    if (authMessage) return { success: false, error: authMessage };
    console.error('Error updating lead stage:', error);
    return { success: false, error: 'Failed to update stage' };
  }
}

export async function markMessageSent(leadId: string, messageSent: string) {
  try {
    const user = await requirePermission('LEAD_MARK_SENT');

    const existing = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    const lead = existing[0];
    if (!lead) return { success: false, error: 'Lead não encontrado.' };

    const now = new Date();
    const oldStage = lead.pipelineStage;

    await db.update(leads)
      .set({
        pipelineStage: 'CONTATO REALIZADO',
        firstContactAt: lead.firstContactAt ?? now,
        lastContactAt: now,
        updatedAt: now,
      })
      .where(eq(leads.id, leadId));

    await db.insert(activities).values([
      {
        id: crypto.randomUUID(),
        leadId,
        type: 'MESSAGE_SENT',
        channel: 'INSTAGRAM',
        direction: 'OUTBOUND',
        content: messageSent,
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        leadId,
        type: 'PIPELINE_CHANGED',
        content: `Pipeline atualizado: ${oldStage} → CONTATO REALIZADO`,
        metadata: JSON.stringify({ from: oldStage, to: 'CONTATO REALIZADO' }),
        createdAt: now,
      },
    ]);

    await logAudit({
      userId: user.id,
      userName: user.name,
      action: 'LEAD_MESSAGE_SENT',
      category: 'MESSAGES',
      entityType: 'LEAD',
      entityId: leadId,
      description: `Registrou envio de mensagem para "${lead.businessName}".`,
    });

    revalidatePath('/prospecting');
    revalidatePath('/pipeline');
    revalidatePath('/');
    revalidatePath(`/leads/${leadId}`);
    return { success: true };
  } catch (error) {
    const authMessage = authErrorMessage(error);
    if (authMessage) return { success: false, error: authMessage };
    console.error('Error marking message sent:', error);
    return { success: false, error: 'Falha ao registrar envio.' };
  }
}

export async function doNotContactLead(leadId: string) {
  try {
    const user = await requirePermission('LEAD_MARK_DO_NOT_CONTACT');

    const existing = await db.select({ pipelineStage: leads.pipelineStage, businessName: leads.businessName }).from(leads).where(eq(leads.id, leadId)).limit(1);
    const oldStage = existing[0]?.pipelineStage ?? 'NOVO';

    await db.update(leads)
      .set({ doNotContact: true, pipelineStage: 'NÃO CONTATAR', updatedAt: new Date() })
      .where(eq(leads.id, leadId));

    await db.insert(activities).values({
      id: crypto.randomUUID(),
      leadId,
      type: 'PIPELINE_CHANGED',
      content: `Lead marcado como NÃO CONTATAR. Pipeline anterior: ${oldStage}`,
      metadata: JSON.stringify({ from: oldStage, to: 'NÃO CONTATAR', doNotContact: true }),
      createdAt: new Date(),
    });

    await logAudit({
      userId: user.id,
      userName: user.name,
      action: 'LEAD_DO_NOT_CONTACT',
      category: 'LEADS',
      entityType: 'LEAD',
      entityId: leadId,
      description: `Marcou "${existing[0]?.businessName ?? leadId}" como Não Contatar.`,
    });

    revalidatePath('/prospecting');
    revalidatePath('/pipeline');
    revalidatePath('/');
    revalidatePath(`/leads/${leadId}`);
    return { success: true };
  } catch (error) {
    const authMessage = authErrorMessage(error);
    if (authMessage) return { success: false, error: authMessage };
    console.error('Error marking do not contact:', error);
    return { success: false, error: 'Falha ao marcar lead.' };
  }
}

export async function addLeadNote(leadId: string, note: string) {
  try {
    const user = await requirePermission('LEAD_UPDATE_NOTES');

    const existing = await db.select({ notes: leads.notes }).from(leads).where(eq(leads.id, leadId)).limit(1);
    const currentNotes = existing[0]?.notes ?? '';
    const timestamp = new Date().toLocaleString('pt-BR');
    const newNotes = currentNotes ? `${currentNotes}\n\n[${timestamp}] ${note}` : `[${timestamp}] ${note}`;

    await db.update(leads)
      .set({ notes: newNotes, updatedAt: new Date() })
      .where(eq(leads.id, leadId));

    await db.insert(activities).values({
      id: crypto.randomUUID(),
      leadId,
      type: 'NOTE',
      content: note,
      createdAt: new Date(),
    });

    await logAudit({
      userId: user.id,
      userName: user.name,
      action: 'LEAD_NOTE_ADDED',
      category: 'LEADS',
      entityType: 'LEAD',
      entityId: leadId,
      description: `Adicionou uma nota ao lead.`,
    });

    revalidatePath(`/leads/${leadId}`);
    return { success: true };
  } catch (error) {
    const authMessage = authErrorMessage(error);
    if (authMessage) return { success: false, error: authMessage };
    console.error('Error adding note:', error);
    return { success: false, error: 'Falha ao salvar nota.' };
  }
}

// Ação destrutiva e irreversível — por isso exige uma permissão própria
// (LEAD_DELETE_ALL, marcada highRisk no catálogo) em vez de cair sob
// LEAD_UPDATE_STAGE ou qualquer permissão mais ampla.
export async function clearAllLeadsAction() {
  try {
    const user = await requirePermission('LEAD_DELETE_ALL');

    const existingLeads = await db.select({ id: leads.id }).from(leads);
    const count = existingLeads.length;

    await db.delete(activities);
    await db.delete(leads);

    await logAudit({
      userId: user.id,
      userName: user.name,
      action: 'LEADS_CLEARED',
      category: 'LEADS',
      description: `Removeu TODOS os leads do sistema (${count} lead(s)). Ação irreversível.`,
      metadata: { count },
    });

    revalidatePath('/prospecting');
    revalidatePath('/pipeline');
    revalidatePath('/leads');
    revalidatePath('/');
    return { success: true };
  } catch (error: any) {
    const authMessage = authErrorMessage(error);
    if (authMessage) return { success: false, error: authMessage };
    console.error('Error clearing leads:', error);
    return { success: false, error: error?.message || 'Failed to clear leads' };
  }
}
