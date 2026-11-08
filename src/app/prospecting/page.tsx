import { db } from '@/db';
import { leads, settings } from '@/db/schema';
import { and, desc, inArray, ne } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getCurrentUser, userHasPermission } from '@/lib/auth-helpers';
import { leadVisibilityCondition } from '@/lib/lead-access';
import { ProspectingQueue } from './prospecting-queue';
import { ProspectingRunPanel } from './prospecting-run-panel';
import { GoogleMapsPanel } from './google-maps-panel';

export const dynamic = 'force-dynamic';

export default async function ProspectingPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser || !userHasPermission(currentUser, 'LEAD_VIEW')) redirect('/');
  let queueLeads = [] as any[];
  let defaultDesiredCount = 10;
  let defaultCity = 'Maceió';
  try {
    const s = (await db.select({ dailyQueueSize: settings.dailyQueueSize, city: settings.city }).from(settings).limit(1))[0];
    defaultDesiredCount = s?.dailyQueueSize ?? 10;
    defaultCity = s?.city?.trim() || defaultCity;
  } catch {
    // Sem settings ainda (banco novo) - mantem o padrao.
  }
  try {
    // Select only safe/existing columns to avoid referencing newly added columns
    // that might not yet be present in the SQLite file (pre-migration).
    queueLeads = await db.select({
      id: leads.id,
      businessName: leads.businessName,
      instagramUsername: leads.instagramUsername,
      instagramUrl: leads.instagramUrl,
      phone: leads.phone,
      whatsapp: leads.whatsapp,
      website: leads.website,
      city: leads.city,
      state: leads.state,
      neighborhood: leads.neighborhood,
      category: leads.category,
      subcategory: leads.subcategory,
      followers: leads.followers,
      rating: leads.rating,
      reviewCount: leads.reviewCount,
      instagramActive: leads.instagramActive,
      leadScore: leads.leadScore,
      qualificationStatus: leads.qualificationStatus,
      notes: leads.notes,
      painPoints: leads.painPoints,
      hasDelivery: leads.hasDelivery,
      hasDiningRoom: leads.hasDiningRoom,
      hasWaiters: leads.hasWaiters,
      pipelineStage: leads.pipelineStage,
      createdAt: leads.createdAt,
      updatedAt: leads.updatedAt,
    }).from(leads)
      .where(and(
        ne(leads.source, 'TEST_FIXTURE'),
        leadVisibilityCondition(currentUser),
        inArray(leads.pipelineStage, ['DESCOBERTO', 'ANALISANDO', 'QUALIFICADO', 'AGUARDANDO_CONTATO', 'NOVO', 'PESQUISANDO', 'PRONTO PARA CONTATO'])
      ))
      .orderBy(desc(leads.leadScore), desc(leads.createdAt))
      .limit(Math.min(Math.max(defaultDesiredCount, 10), 100));
  } catch (err: any) {
    // If migrations haven't been applied or a column is missing, avoid crashing the page.
    console.error('[PROSPECTING] DB query failed:', err?.message ?? err);
    queueLeads = [];
  }

  return (
    <div className="h-full flex flex-col space-y-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Fila de Prospecção</h1>
        <p className="text-neutral-700 dark:text-neutral-300">Modo Assistido - Analise leads, gere mensagens e aprove os envios.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ProspectingRunPanel defaultDesiredCount={defaultDesiredCount} />
        <GoogleMapsPanel defaultCity={defaultCity} />
      </div>

      <div className="flex-1 overflow-auto">
        <ProspectingQueue initialLeads={queueLeads} />
      </div>
    </div>
  );
}
