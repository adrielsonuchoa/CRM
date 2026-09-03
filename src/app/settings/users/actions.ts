'use server';

import { db } from '@/db';
import { users, userPermissions } from '@/db/schema';
import { eq, and, ne } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { requirePermission, AuthError, ForbiddenError } from '@/lib/auth-helpers';
import { logAudit } from '@/lib/audit-log';
import { ALL_PERMISSION_KEYS, type PermissionKey } from '@/lib/permissions';

function authErrorMessage(error: unknown): string | null {
  if (error instanceof AuthError || error instanceof ForbiddenError) return error.message;
  return null;
}

const VALID_ROLES = ['SUPER_ADMIN', 'ADMIN', 'VENDEDOR'] as const;
const VALID_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Nunca confiamos nas chaves de permissão que vêm do formulário: só as que
// existirem no catálogo oficial (src/lib/permissions.ts) são aceitas —
// qualquer string desconhecida enviada por um cliente adulterado é
// descartada em silêncio, nunca gravada em user_permissions.
function sanitizePermissionKeys(raw: FormDataEntryValue[]): PermissionKey[] {
  const allowed = new Set<string>(ALL_PERMISSION_KEYS);
  const seen = new Set<PermissionKey>();
  for (const item of raw) {
    const value = String(item);
    if (allowed.has(value)) seen.add(value as PermissionKey);
  }
  return Array.from(seen);
}

async function replaceUserPermissions(userId: string, keys: PermissionKey[]) {
  await db.delete(userPermissions).where(eq(userPermissions.userId, userId));
  if (keys.length > 0) {
    const now = new Date();
    await db.insert(userPermissions).values(
      keys.map((key) => ({ id: crypto.randomUUID(), userId, permissionKey: key, createdAt: now })),
    );
  }
}

export async function createUserAction(formData: FormData) {
  try {
    const currentUser = await requirePermission('USERS_MANAGE');

    const name = String(formData.get('name') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    const password = String(formData.get('password') ?? '');
    const roleRaw = String(formData.get('role') ?? '');
    const role = (VALID_ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as (typeof VALID_ROLES)[number]) : 'VENDEDOR';
    const permissionKeys = sanitizePermissionKeys(formData.getAll('permissions'));

    if (!name) return { success: false, error: 'Informe o nome.' };
    if (!EMAIL_RE.test(email)) return { success: false, error: 'E-mail inválido.' };
    if (password.length < 8) return { success: false, error: 'A senha precisa ter pelo menos 8 caracteres.' };

    const existing = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0];
    if (existing) return { success: false, error: 'Já existe um usuário com esse e-mail.' };

    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();
    const newUserId = crypto.randomUUID();

    await db.insert(users).values({
      id: newUserId,
      name,
      email,
      passwordHash,
      role,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    if (permissionKeys.length > 0) {
      await replaceUserPermissions(newUserId, permissionKeys);
    }

    await logAudit({
      userId: currentUser.id,
      userName: currentUser.name,
      action: 'USER_CREATED',
      category: 'USERS',
      entityType: 'USER',
      entityId: newUserId,
      description: `Criou o usuário "${name}" <${email}> (papel: ${role}).`,
      metadata: { role, permissionCount: permissionKeys.length },
    });

    revalidatePath('/settings/users');
    return { success: true };
  } catch (error) {
    const authMessage = authErrorMessage(error);
    if (authMessage) return { success: false, error: authMessage };
    console.error('Error creating user:', error);
    return { success: false, error: 'Não foi possível criar o usuário.' };
  }
}

export async function updateUserAction(userId: string, formData: FormData) {
  try {
    const currentUser = await requirePermission('USERS_MANAGE');

    const target = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!target) return { success: false, error: 'Usuário não encontrado.' };

    const name = String(formData.get('name') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    const password = String(formData.get('password') ?? '');
    const roleRaw = String(formData.get('role') ?? target.role);
    const statusRaw = String(formData.get('status') ?? target.status);
    const role = (VALID_ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as (typeof VALID_ROLES)[number]) : target.role;
    const status = (VALID_STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as (typeof VALID_STATUSES)[number]) : target.status;
    const permissionKeys = sanitizePermissionKeys(formData.getAll('permissions'));

    if (!name) return { success: false, error: 'Informe o nome.' };
    if (!EMAIL_RE.test(email)) return { success: false, error: 'E-mail inválido.' };

    const isSelf = currentUser.id === userId;
    const roleChanged = role !== target.role;
    const statusChanged = status !== target.status;

    // Ninguém pode alterar o próprio papel, status ou permissões — nem o
    // SUPER_ADMIN. Evita um admin se trancar pra fora (ou se rebaixar) por
    // engano, e fecha um vetor óbvio de escalada de privilégio.
    if (isSelf && (roleChanged || statusChanged)) {
      return { success: false, error: 'Você não pode alterar seu próprio papel ou status.' };
    }
    // Permissões da própria conta: a UI esconde a aba inteira ao editar a
    // si mesmo, e o bloco abaixo ("if (!isSelf) replaceUserPermissions")
    // garante isso também no servidor — a submissão simplesmente ignora
    // qualquer permissionKeys enviado quando isSelf é true.

    // Nunca deixar o sistema sem nenhum SUPER_ADMIN ativo.
    if (statusChanged && status === 'INACTIVE' && target.role === 'SUPER_ADMIN') {
      const otherActiveAdmins = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'SUPER_ADMIN'), eq(users.status, 'ACTIVE'), ne(users.id, userId)));
      if (otherActiveAdmins.length === 0) {
        return { success: false, error: 'Não é possível desativar o único SUPER_ADMIN ativo do sistema.' };
      }
    }
    if (roleChanged && target.role === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN') {
      const otherActiveAdmins = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'SUPER_ADMIN'), eq(users.status, 'ACTIVE'), ne(users.id, userId)));
      if (otherActiveAdmins.length === 0) {
        return { success: false, error: 'Não é possível rebaixar o único SUPER_ADMIN ativo do sistema.' };
      }
    }

    if (email !== target.email) {
      const emailTaken = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0];
      if (emailTaken) return { success: false, error: 'Já existe um usuário com esse e-mail.' };
    }

    const updateData: Partial<typeof users.$inferInsert> = {
      name,
      email,
      role,
      status,
      updatedAt: new Date(),
    };

    let passwordChanged = false;
    if (password) {
      if (password.length < 8) return { success: false, error: 'A senha precisa ter pelo menos 8 caracteres.' };
      updateData.passwordHash = await bcrypt.hash(password, 12);
      passwordChanged = true;
    }

    await db.update(users).set(updateData).where(eq(users.id, userId));

    if (!isSelf) {
      await replaceUserPermissions(userId, permissionKeys);
    }

    const changes: string[] = [];
    if (name !== target.name) changes.push('nome');
    if (email !== target.email) changes.push('e-mail');
    if (roleChanged) changes.push(`papel (${target.role} → ${role})`);
    if (statusChanged) changes.push(`status (${target.status} → ${status})`);
    if (passwordChanged) changes.push('senha');
    if (!isSelf) changes.push('permissões');

    await logAudit({
      userId: currentUser.id,
      userName: currentUser.name,
      action: 'USER_UPDATED',
      category: 'USERS',
      entityType: 'USER',
      entityId: userId,
      description: `Atualizou o usuário "${target.name}": ${changes.join(', ') || 'nenhuma alteração'}.`,
    });

    revalidatePath('/settings/users');
    return { success: true };
  } catch (error) {
    const authMessage = authErrorMessage(error);
    if (authMessage) return { success: false, error: authMessage };
    console.error('Error updating user:', error);
    return { success: false, error: 'Não foi possível atualizar o usuário.' };
  }
}
