import { db } from '@/db';
import { leads } from '@/db/schema';
import { PipelineBoard } from '@/components/pipeline/pipeline-board';
import { desc, notInArray } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export default async function PipelinePage() {
  const allLeads = await db.select().from(leads).where(notInArray(leads.pipelineStage, ['DESCARTADO', 'PERDIDO', 'NÃO CONTATAR'])).orderBy(desc(leads.leadScore));

  return (
    <div className="h-full flex flex-col space-y-4">
      <div className="flex flex-col gap-1 shrink-0">
        <h1 className="text-3xl font-bold tracking-tight">Pipeline de Vendas</h1>
        <p className="text-neutral-500">Acompanhe as transições reais do relacionamento com cada cliente. A automação atualiza as etapas operacionais.</p>
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto pb-4">
        <PipelineBoard initialLeads={allLeads} />
      </div>
    </div>
  );
}
