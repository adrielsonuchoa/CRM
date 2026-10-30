import type { Client } from '@libsql/client';

// Colunas que existem em src/db/schema.ts mas nunca entraram numa migracao
// do Drizzle - os bancos antigos ganharam via scripts/migrate-db.ts (manual).
// Num banco novo (instalacao de cliente, CI) elas faltavam e todo INSERT em
// leads quebrava. Nao da pra virar uma migracao comum: ALTER TABLE ADD
// COLUMN falha nos bancos que ja tem a coluna e o SQLite nao tem
// "IF NOT EXISTS" pra coluna. Por isso a checagem idempotente aqui, rodada
// pelo db:migrate depois das migracoes.
const LEGACY_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'leads', column: 'conversation_provider', definition: "TEXT DEFAULT 'BROWSER'" },
  { table: 'leads', column: 'meta_psid', definition: 'TEXT' },
];

export async function ensureLegacyColumns(client: Client): Promise<string[]> {
  const added: string[] = [];
  for (const { table, column, definition } of LEGACY_COLUMNS) {
    const info = await client.execute(`PRAGMA table_info(${table});`);
    if (info.rows.some((row) => row.name === column)) continue;
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    added.push(`${table}.${column}`);
  }
  return added;
}
