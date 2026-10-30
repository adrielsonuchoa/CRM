'use server';

import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db';
import { leads, tasks } from '@/db/schema';
import { AuthError, ForbiddenError, requirePermission } from '@/lib/auth-helpers';
import { logAudit } from '@/lib/audit-log';
import { FOLLOW_UP_TASK_TYPE, MANUAL_TASK_TYPE, TASK_STATUS } from '@/lib/follow-ups';
import { canAccessLead } from '@/lib/lead-access';

// Tarefas usam a mesma permissao das notas (LEAD_UPDATE_NOTES): sao
// anotacoes com data, e assim nenhum usuario existente precisa ganhar uma
// permissao nova pra continuar trabalhando.

function authErrorMessage(error: unknown): string | null {
  if (error instanceof AuthError || error instanceof ForbiddenError) return error.message;
  return null;
}

function revalidateTaskViews(leadId: string) {
  revalidatePath('/tasks');
  revalidatePath('/');
  revalidatePath(`/leads/${leadId}`);
}

export async function createTaskAction(leadId: string, title: string, dueAtIso: string | null, notes?: string) {
  try {
    const user = await requirePermission('LEAD_UPDATE_NOTES');
    const cleanTitle = title.trim().slice(0, 200);
    if (!cleanTitle) return { success: false, error: 'Informe o título da tarefa.' };
    if (!(await canAccessLead(user, leadId))) return { success: false, error: 'Lead não encontrado.' };

    let dueAt: Date | null = null;
    if (dueAtIso) {
      dueAt = new Date(dueAtIso);
      if (Number.isNaN(dueAt.getTime())) return { success: false, error: 'Data inválida.' };
    }

    await db.insert(tasks).values({
      id: crypto.randomUUID(),
      leadId,
      type: MANUAL_TASK_TYPE,
      title: cleanTitle,
      dueAt,
      status: TASK_STATUS.PENDING,
      notes: notes?.trim() || null,
      createdAt: new Date(),
    });

    await logAudit({
      userId: user.id,
      userName: user.name,
      action: 'TASK_CREATED',
      category: 'LEADS',
      entityType: 'LEAD',
      entityId: leadId,
      description: `Criou a tarefa "${cleanTitle}".`,
    });

    revalidateTaskViews(leadId);
    return { success: true };
  } catch (error) {
    const authMessage = authErrorMessage(error);
    if (authMessage) return { success: false, error: authMessage };
    console.error('Error creating task:', error);
    return { success: false, error: 'Falha ao criar tarefa.' };
  }
}

async function closeTask(taskId: string, status: typeof TASK_STATUS.DONE | typeof TASK_STATUS.CANCELED) {
  try {
    const user = await requirePermission('LEAD_UPDATE_NOTES');
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0];
    if (!task || !(await canAccessLead(user, task.leadId))) return { success: false, error: 'Tarefa não encontrada.' };
    if (task.status !== TASK_STATUS.PENDING) return { success: false, error: 'Tarefa já encerrada.' };

    await db.update(tasks)
      .set({ status, completedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, TASK_STATUS.PENDING)));

    // Follow-up encerrado na mao: o lead fica sem proximo follow-up ate o
    // proximo envio registrado (que agenda o seguinte).
    if (task.type === FOLLOW_UP_TASK_TYPE) {
      await db.update(leads).set({ nextFollowUpAt: null }).where(eq(leads.id, task.leadId));
    }

    await logAudit({
      userId: user.id,
      userName: user.name,
      action: status === TASK_STATUS.DONE ? 'TASK_COMPLETED' : 'TASK_CANCELED',
      category: 'LEADS',
      entityType: 'LEAD',
      entityId: task.leadId,
      description: `${status === TASK_STATUS.DONE ? 'Concluiu' : 'Cancelou'} a tarefa "${task.title}".`,
    });

    revalidateTaskViews(task.leadId);
    return { success: true };
  } catch (error) {
    const authMessage = authErrorMessage(error);
    if (authMessage) return { success: false, error: authMessage };
    console.error('Error closing task:', error);
    return { success: false, error: 'Falha ao atualizar tarefa.' };
  }
}

export async function completeTaskAction(taskId: string) {
  return closeTask(taskId, TASK_STATUS.DONE);
}

export async function cancelTaskAction(taskId: string) {
  return closeTask(taskId, TASK_STATUS.CANCELED);
}
