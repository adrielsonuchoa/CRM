import { NextResponse } from 'next/server';
import { db } from '@/db';
import { activities, leads } from '@/db/schema';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';

const prospects = [
  { name: 'Mercatto Restaurante e Pizzaria', username: 'pizzaria_mercatto', city: 'Maceió', category: 'Restaurante' },
  { name: 'Mercatto Pizzaria', username: 'mercattopizzaria', city: 'Maceió', category: 'Restaurante' },
  { name: 'Toscana Restaurante', username: 'toscanarestaurante', city: 'Maceió', category: 'Restaurante' },
  { name: 'ARCO Restaurante', username: 'arco.673', city: 'Maceió', category: 'Restaurante' },
  { name: 'Garuva Restaurante', username: 'garuvarestaurante', city: 'Maceió', category: 'Restaurante' },
  { name: 'Rancho Parrilla', username: 'ranchoparrillamaceio', city: 'Maceió', category: 'Restaurante' },
  { name: 'Manguezal Restaurante', username: 'manguezalrestaurante_', city: 'Maceió', category: 'Restaurante' },
  { name: 'Micale', username: 'micalerestaurante', city: 'Maceió', category: 'Restaurante' },
  { name: 'Mima Restaurante', username: 'mimarestaurante', city: 'Maceió', category: 'Restaurante' },
  { name: 'Oxê Maceió', username: 'oxe_maceio', city: 'Maceió', category: 'Restaurante' },
  { name: 'Onde Comer em Maceió', username: 'ondecomeremmaceio', city: 'Maceió', category: 'Restaurante' },
  { name: 'Ana Maria Restaurante', username: 'anamaresttaurante', city: 'Maceió', category: 'Restaurante' },
];

export async function GET() {
  let created = 0;
  let skipped = 0;

  for (const prospect of prospects) {
    const cleanUsername = prospect.username.replace(/^@/, '').trim().toLowerCase();
    const existing = await db.select().from(leads).where(eq(leads.instagramUsername, cleanUsername)).limit(1);
    if (existing.length > 0) {
      skipped++;
      continue;
    }

    const now = new Date();
    const leadId = crypto.randomUUID();

    await db.insert(leads).values({
      id: leadId,
      businessName: prospect.name,
      instagramUsername: cleanUsername,
      instagramUrl: `https://www.instagram.com/${cleanUsername}/`,
      city: prospect.city,
      state: 'AL',
      category: prospect.category,
      source: 'INSTAGRAM_CDP',
      qualificationStatus: 'DESCOBERTO',
      pipelineStage: 'DESCOBERTO',
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(activities).values({
      id: crypto.randomUUID(),
      leadId,
      type: 'LEAD_CREATED',
      channel: 'INSTAGRAM',
      content: `[INSTAGRAM_CDP] Lead inserido via busca pública: ${prospect.name}`,
      metadata: JSON.stringify({ source: 'INSTAGRAM_CDP', username: cleanUsername }),
      createdAt: now,
    });

    created++;
  }

  return NextResponse.json({ success: true, created, skipped, total: created + skipped });
}
