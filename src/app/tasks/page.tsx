import { redirect } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { leads, tasks } from '@/db/schema';
import { getCurrentUser, userHasPermission } from '@/lib/auth-helpers';
import { TASK_STATUS } from '@/lib/follow-ups';
import { canViewAllLeads } from '@/lib/lead-access';
import { buildWhatsAppUrl } from '@/lib/phone';
import { TasksClient } from './tasks-client';

export const metadata = {
  title: 'Tarefas | Sirrus CRM',
};

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser || !userHasPermission(currentUser, 'LEAD_VIEW')) {
    redirect('/');
  }

  const conditions = [eq(tasks.status, TASK_STATUS.PENDING)];
  if (!canViewAllLeads(currentUser)) conditions.push(eq(leads.assignedUserId, currentUser.id));

  const rows = await db
    .select({
      id: tasks.id,
      type: tasks.type,
      title: tasks.title,
      notes: tasks.notes,
      dueAt: tasks.dueAt,
      leadId: leads.id,
      businessName: leads.businessName,
      pipelineStage: leads.pipelineStage,
      phone: leads.phone,
      whatsapp: leads.whatsapp,
      instagramUsername: leads.instagramUsername,
    })
    .from(tasks)
    .innerJoin(leads, eq(tasks.leadId, leads.id))
    .where(and(...conditions))
    .orderBy(asc(tasks.dueAt));

  const tasksForClient = rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    notes: row.notes,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    leadId: row.leadId,
    businessName: row.businessName,
    pipelineStage: row.pipelineStage,
    instagramUsername: row.instagramUsername,
    whatsAppUrl: buildWhatsAppUrl(row.whatsapp ?? row.phone),
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Tarefas</h1>
        <p className="text-neutral-500">
          Follow-ups agendados automaticamente após cada contato e tarefas criadas nos leads.
        </p>
      </div>

      <TasksClient initialTasks={tasksForClient} />
    </div>
  );
}
