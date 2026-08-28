import { db } from '@/db';
import { leads, activities } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { LeadDetailClient } from './lead-detail-client';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await db.select({ businessName: leads.businessName }).from(leads).where(eq(leads.id, id)).limit(1);
  return { title: `${result[0]?.businessName ?? 'Lead'} | Sirrus CRM` };
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const leadRecord = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  const lead = leadRecord[0];

  if (!lead) notFound();

  const leadActivities = await db
    .select()
    .from(activities)
    .where(eq(activities.leadId, id))
    .orderBy(desc(activities.createdAt))
    .limit(50);

  return <LeadDetailClient lead={lead} activities={leadActivities} />;
}
