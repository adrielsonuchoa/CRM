import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

// Antes fixo em 'file:sqlite.db' — passou a respeitar TURSO_DATABASE_URL,
// igual ao runtime (src/db/index.ts) e ao drizzle.config.ts, pra migração e
// aplicação sempre baterem no mesmo banco.
const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || 'file:sqlite.db';
const authToken = process.env.TURSO_AUTH_TOKEN;
const client = createClient({ url, authToken: authToken || undefined });
const db = drizzle(client);

async function runMigrate() {
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete!');
  client.close();
}

runMigrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
