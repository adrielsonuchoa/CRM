// Copia UM usuario ja existente (por email) de um banco de origem (ex.: o
// Turso remoto usado em dev) para um sqlite.db local novo, ja migrado. Usado
// pelo prepare-client-installer.ps1 quando o cliente vai usar uma conta que
// ja existe (com senha ja definida) em vez de criar uma nova via
// bootstrap-admin. A senha (hash) e copiada como esta - o cliente continua
// entrando com a mesma senha que ja usava.
//
// Variaveis de ambiente esperadas:
//   SOURCE_DATABASE_URL, SOURCE_TURSO_AUTH_TOKEN  -> banco de onde copiar
//   TARGET_DB_PATH                                 -> ex.: file:sqlite.db (destino)
//   EXPORT_USER_EMAIL                              -> email do usuario a copiar
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { users, userPermissions } from '../src/db/schema';
import { ensureLegacyColumns } from '../src/db/ensure-columns';

const sourceUrl = process.env.SOURCE_DATABASE_URL?.trim();
const sourceToken = process.env.SOURCE_TURSO_AUTH_TOKEN?.trim();
const targetPath = process.env.TARGET_DB_PATH?.trim();
const email = process.env.EXPORT_USER_EMAIL?.trim().toLowerCase();

if (!sourceUrl || !targetPath || !email) {
  console.error('[export-user] Faltam variaveis: SOURCE_DATABASE_URL, TARGET_DB_PATH, EXPORT_USER_EMAIL.');
  process.exit(1);
}

async function main() {
  const sourceClient = createClient({ url: sourceUrl!, authToken: sourceToken || undefined });
  const sourceDb = drizzle(sourceClient);

  const [user] = await sourceDb.select().from(users).where(eq(users.email, email!)).limit(1);
  if (!user) {
    console.error(`[export-user] Usuario com email "${email}" nao encontrado no banco de origem.`);
    process.exit(1);
  }

  const permissionRows = await sourceDb
    .select()
    .from(userPermissions)
    .where(eq(userPermissions.userId, user.id));

  const targetClient = createClient({ url: targetPath! });
  const targetDb = drizzle(targetClient);
  await migrate(targetDb, { migrationsFolder: './drizzle' });
  await ensureLegacyColumns(targetClient);
  await targetDb.insert(users).values(user);
  if (permissionRows.length > 0) {
    await targetDb.insert(userPermissions).values(permissionRows);
  }

  console.log(`[export-user] Usuario "${user.name}" <${user.email}> (${user.role}) copiado para o banco local do cliente, com ${permissionRows.length} permissao(oes).`);
  sourceClient.close();
  targetClient.close();
}

main().catch((err) => {
  console.error('[export-user] Falha ao exportar usuario:', err);
  process.exit(1);
});
