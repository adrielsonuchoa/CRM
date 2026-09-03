import { redirect } from 'next/navigation';
import { db } from '@/db';
import { users, userPermissions } from '@/db/schema';
import { getCurrentUser, userHasPermission } from '@/lib/auth-helpers';
import { UsersClient } from './users-client';

export const metadata = {
  title: 'Usuários | Sirrus CRM',
};

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser || !userHasPermission(currentUser, 'USERS_VIEW')) {
    redirect('/');
  }

  const [allUsers, allPermissionRows] = await Promise.all([
    db.select().from(users).orderBy(users.createdAt),
    db.select().from(userPermissions),
  ]);

  const permissionsByUser = new Map<string, string[]>();
  for (const row of allPermissionRows) {
    const list = permissionsByUser.get(row.userId) ?? [];
    list.push(row.permissionKey);
    permissionsByUser.set(row.userId, list);
  }

  const usersForClient = allUsers.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
    permissions: permissionsByUser.get(u.id) ?? [],
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Usuários</h1>
        <p className="text-neutral-500">
          Gerencie quem tem acesso ao CRM e o que cada pessoa pode fazer. Só o SUPER_ADMIN e quem tiver a permissão
          &quot;Criar, editar, desativar e definir permissões de usuários&quot; pode alterar algo aqui.
        </p>
      </div>

      <UsersClient
        initialUsers={usersForClient}
        currentUserId={currentUser.id}
        canManage={userHasPermission(currentUser, 'USERS_MANAGE')}
      />
    </div>
  );
}
