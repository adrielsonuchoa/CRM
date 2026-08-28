import { db } from '@/db';
import { leads } from '@/db/schema';
import { inArray, desc } from 'drizzle-orm';
import { ProspectingQueue } from './prospecting-queue';

export default async function ProspectingPage() {
  const queueLeads = await db.select().from(leads)
    .where(inArray(leads.pipelineStage, ['NOVO', 'PESQUISANDO', 'QUALIFICADO', 'PRONTO PARA CONTATO']))
    .orderBy(desc(leads.leadScore))
    .limit(10);

  return (
    <div className="h-full flex flex-col space-y-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Fila de Prospecção</h1>
        <p className="text-neutral-500">Modo Assistido - Analise leads, gere mensagens e aprove os envios.</p>
      </div>

      <div className="flex-1 overflow-auto">
        <ProspectingQueue initialLeads={queueLeads} />
      </div>
    </div>
  );
}
