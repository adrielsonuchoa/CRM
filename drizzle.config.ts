import type { Config } from 'drizzle-kit';

// Antes fixo em 'file:sqlite.db' — as migrações eram sempre aplicadas no
// arquivo local, mesmo depois de configurar TURSO_DATABASE_URL pra rodar em
// produção. Isso faria o app em produção (via src/db/index.ts, que já lê o
// Turso) rodar num banco sem as tabelas novas. Agora usa a mesma variável.
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || 'file:sqlite.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
} satisfies Config;
