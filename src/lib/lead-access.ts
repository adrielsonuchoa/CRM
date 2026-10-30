import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { leads } from '@/db/schema';
import { userHasPermission, type CurrentUser } from '@/lib/auth-helpers';

// Regra da permissao VIEW_ALL_LEADS (ver src/lib/permissions.ts): sem ela,
// o usuario so enxerga os leads atribuidos a ele (leads.assigned_user_id).
export function canViewAllLeads(user: CurrentUser) {
  return userHasPermission(user, 'VIEW_ALL_LEADS');
}

export async function canAccessLead(user: CurrentUser, leadId: string) {
  const lead = (await db.select({ assignedUserId: leads.assignedUserId }).from(leads).where(eq(leads.id, leadId)).limit(1))[0];
  if (!lead) return false;
  return canViewAllLeads(user) || lead.assignedUserId === user.id;
}
