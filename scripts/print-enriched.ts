import { db } from '@/db';
import { leads } from '@/db/schema';
import { not, isNull } from 'drizzle-orm';

async function main() {
  const rows = await db.select().from(leads).where(not(isNull(leads.instagramUsername))).orderBy(leads.createdAt);
  console.log('Leads com instagramUsername preenchido:', rows.length);
  for (const r of rows.slice(-20)) {
    console.log(r.id, r.businessName, r.instagramUsername, r.followers);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
