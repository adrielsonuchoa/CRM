import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const client = createClient({ url: 'file:sqlite.db' });
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
