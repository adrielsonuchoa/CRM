'use server';

import { db } from '@/db';
import { leads, activities } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import crypto from 'crypto';

export async function updateLeadStage(leadId: string, newStage: string) {
  try {
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

    revalidatePath('/pipeline');
    revalidatePath('/');
    revalidatePath(`/leads/${leadId}`);
    return { success: true };
  } catch (error) {
    console.error('Error updating lead stage:', error);
    return { success: false, error: 'Failed to update stage' };
  }
}

export async function markMessageSent(leadId: string, messageSent: string) {
  try {
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

    revalidatePath('/prospecting');
    revalidatePath('/pipeline');
    revalidatePath('/');
    revalidatePath(`/leads/${leadId}`);
    return { success: true };
  } catch (error) {
    console.error('Error marking message sent:', error);
    return { success: false, error: 'Falha ao registrar envio.' };
  }
}

export async function doNotContactLead(leadId: string) {
  try {
    const existing = await db.select({ pipelineStage: leads.pipelineStage }).from(leads).where(eq(leads.id, leadId)).limit(1);
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

    revalidatePath('/prospecting');
    revalidatePath('/pipeline');
    revalidatePath('/');
    revalidatePath(`/leads/${leadId}`);
    return { success: true };
  } catch (error) {
    console.error('Error marking do not contact:', error);
    return { success: false, error: 'Falha ao marcar lead.' };
  }
}

export async function addLeadNote(leadId: string, note: string) {
  try {
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

    revalidatePath(`/leads/${leadId}`);
    return { success: true };
  } catch (error) {
    console.error('Error adding note:', error);
    return { success: false, error: 'Falha ao salvar nota.' };
  }
}

export async function clearAllLeadsAction() {
  try {
    await db.delete(activities);
    await db.delete(leads);
    revalidatePath('/prospecting');
    revalidatePath('/pipeline');
    revalidatePath('/leads');
    revalidatePath('/');
    return { success: true };
  } catch (error: any) {
    console.error('Error clearing leads:', error);
    return { success: false, error: error?.message || 'Failed to clear leads' };
  }
}

