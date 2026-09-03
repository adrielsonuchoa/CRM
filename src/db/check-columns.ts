import { createClient } from '@libsql/client';

// Script de diagnóstico TEMPORÁRIO — só lê a estrutura da tabela, não altera
// nada. Rode com: npx tsx --env-file=.env.local src/db/check-columns.ts
// Pode apagar depois de usar.
const client = createClient({
  url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || 'file:sqlite.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;");
  console.log('\n=== Tabelas existentes ===');
  console.log(tables.rows.map((r) => r.name).join(', '));

  const leadsCols = await client.execute('PRAGMA table_info(leads);');
  console.log('\n=== Colunas de leads ===');
  console.log(leadsCols.rows.map((r) => r.name).join(', '));

  const checkCols = ['profile_score', 'profile_accepted', 'keyword_hits', 'profile_snippet', 'posts_count', 'profile_diagnostics'];
  const present = leadsCols.rows.map((r) => String(r.name));
  console.log('\n=== Checagem das colunas de diagnóstico do Instagram ===');
  for (const col of checkCols) {
    console.log(`${col}: ${present.includes(col) ? 'EXISTE' : 'FALTANDO'}`);
  }

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
