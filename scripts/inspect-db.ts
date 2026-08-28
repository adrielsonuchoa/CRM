import { db } from '../src/db';
import { leads, settings } from '../src/db/schema';
import { desc } from 'drizzle-orm';

async function main() {
  const topLeads = await db.select().from(leads).orderBy(desc(leads.leadScore)).limit(10);
  console.log('TOP LEADS:');
  for (const l of topLeads) {
    console.log(`- ${l.businessName} | ig=${l.instagramUsername ?? '—'} | score=${l.leadScore} | followers=${l.followers} | source=${l.source} | stage=${l.pipelineStage}`);
  }
  const s = (await db.select().from(settings).limit(1))[0];
  if (s) {
    console.log('\nSETTINGS:', {
      dryRun: s.prospectionDryRun,
      sources: s.prospectingSources,
      minScore: s.minScoreForQueue,
      queueSize: s.dailyQueueSize,
      cities: s.prospectingCities,
    });
  }
  const withIg = topLeads.filter((l) => l.instagramUsername).length;
  console.log(`\nLeads com Instagram na amostra: ${withIg}/${topLeads.length}`);
}

main().catch(console.error);
