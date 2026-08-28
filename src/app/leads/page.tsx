import { db } from '@/db';
import { leads } from '@/db/schema';
import { desc } from 'drizzle-orm';
import { LeadsTable } from './leads-table';

export const metadata = {
  title: 'Leads | Sirrus CRM',
};

export const dynamic = 'force-dynamic';

export default async function LeadsPage() {
  const allLeads = await db.select().from(leads).orderBy(desc(leads.createdAt));

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

      <LeadsTable initialLeads={allLeads} />
    </div>
  );
}
