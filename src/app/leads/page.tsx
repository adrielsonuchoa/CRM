import { db } from '@/db';
import { leads, activities } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser, userHasPermission } from '@/lib/auth-helpers';
import { leadVisibilityCondition } from '@/lib/lead-access';
import { LeadsTable } from './leads-table';

export const metadata = {
  title: 'Leads | Sirrus CRM',
};

export const dynamic = 'force-dynamic';

export default async function LeadsPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser || !userHasPermission(currentUser, 'LEAD_VIEW')) redirect('/');
  const allLeads = await db.select().from(leads).where(leadVisibilityCondition(currentUser)).orderBy(desc(leads.createdAt));

  // Última mensagem gerada por IA de cada lead (pra pré-preencher o link do
  // WhatsApp) - uma query só pra todos os leads, em vez de N+1.
  const generatedMessages = await db
    .select({ leadId: activities.leadId, content: activities.content })
    .from(activities)
    .where(eq(activities.type, 'MESSAGE_GENERATED'))
    .orderBy(desc(activities.createdAt));

  const lastMessageByLead = new Map<string, string>();
  for (const row of generatedMessages) {
    if (row.content && !lastMessageByLead.has(row.leadId)) {
      lastMessageByLead.set(row.leadId, row.content);
    }
  }

  const leadsWithMessage = allLeads.map((lead) => ({
    ...lead,
    lastGeneratedMessage: lastMessageByLead.get(lead.id) ?? null,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between items-center gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">Leads</h1>
          <p className="text-neutral-500">
            {allLeads.length} estabelecimento{allLeads.length !== 1 ? 's' : ''} cadastrado{allLeads.length !== 1 ? 's' : ''}.
          </p>
        </div>
      </div>

      <LeadsTable initialLeads={leadsWithMessage} />
    </div>
  );
}
