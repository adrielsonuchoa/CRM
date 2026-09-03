import { auth } from '@/auth';
import { db } from '@/db';
import { users, userPermissions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { PermissionKey } from '@/lib/permissions';

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  permissions: PermissionKey[];
};

export class AuthError extends Error {
  constructor(message = 'Não autenticado.') {
    super(message);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Sem permissão para executar esta ação.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Retorna o usuário autenticado com dados FRESCOS do banco (status +
 * permissões) a cada chamada — nunca os dados congelados no JWT/cookie.
 * É isso que garante que uma desativação de usuário ou a revogação de uma
 * permissão feita por um admin valham imediatamente na próxima ação, sem
 * esperar o token expirar ou o usuário logar de novo.
 *
 * Retorna null se não houver sessão válida, se o usuário tiver sido
 * removido do banco, ou se estiver com status INACTIVE.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  const sessionUserId = session?.user?.id;
  if (!sessionUserId) return null;

  const record = (await db.select().from(users).where(eq(users.id, sessionUserId)).limit(1))[0];
  if (!record) return null;
  if (record.status !== 'ACTIVE') return null;

  const permissionRows = await db
    .select({ permissionKey: userPermissions.permissionKey })
    .from(userPermissions)
    .where(eq(userPermissions.userId, record.id));

  return {
    id: record.id,
    name: record.name,
    email: record.email,
    role: record.role,
    status: record.status,
    permissions: permissionRows.map((row) => row.permissionKey) as PermissionKey[],
  };
}

// SUPER_ADMIN sempre tem acesso total, por código — não depende de nenhuma
// linha em user_permissions (ver comentário em src/db/schema.ts).
export function userHasPermission(user: CurrentUser, key: PermissionKey): boolean {
  if (user.role === 'SUPER_ADMIN') return true;
  return user.permissions.includes(key);
}

/**
 * Use no topo de toda server action/rota que executa uma ação sensível.
 * Lança AuthError se não houver sessão válida, ForbiddenError se a sessão
 * for válida mas faltar a permissão exigida. SUPER_ADMIN sempre passa.
 *
 * Importante: nunca confie numa flag de permissão vinda do frontend (props,
 * body da requisição, etc.) — esta função é a única fonte de verdade sobre
 * o que o usuário logado pode fazer, e ela sempre lê o banco na hora, nunca
 * o token da sessão.
 */
export async function requirePermission(key: PermissionKey): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError();
  if (!userHasPermission(user, key)) throw new ForbiddenError();
  return user;
}

/**
 * Variante para ações que só exigem uma sessão válida (qualquer usuário
 * ativo pode chamar), sem checar uma permissão específica da tabela
 * user_permissions.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError();
  return user;
}

/**
 * Impede que um usuário altere as próprias permissões/role/status — mesmo
 * sendo SUPER_ADMIN. Use nas actions de edição de usuário antes de
 * qualquer escrita, comparando o id do usuário logado com o id do usuário
 * sendo editado.
 */
export function assertNotSelfPermissionChange(currentUserId: string, targetUserId: string): void {
  if (currentUserId === targetUserId) {
    throw new ForbiddenError('Você não pode alterar suas próprias permissões, papel ou status.');
  }
}
