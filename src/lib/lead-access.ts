import { eq, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { leads } from '@/db/schema';
import { userHasPermission, type CurrentUser } from '@/lib/auth-helpers';

// Regra da permissao VIEW_ALL_LEADS (ver src/lib/permissions.ts): sem ela,
// o usuario so enxerga os leads atribuidos a ele - e os que ainda nao tem
// dono (assigned_user_id vazio). Sem essa segunda parte, como a descoberta
// automatica cria todo lead sem dono, um vendedor nao veria lead nenhum.
export function canViewAllLeads(user: CurrentUser) {
  return userHasPermission(user, 'VIEW_ALL_LEADS');
}

// Condicao pra usar no WHERE das consultas de leads; undefined = sem filtro
// (o drizzle ignora undefined dentro de and()).
export function leadVisibilityCondition(user: CurrentUser): SQL | undefined {
  if (canViewAllLeads(user)) return undefined;
  return or(eq(leads.assignedUserId, user.id), isNull(leads.assignedUserId));
}

export function canSeeLead(user: CurrentUser, lead: { assignedUserId: string | null }) {
  return canViewAllLeads(user) || !lead.assignedUserId || lead.assignedUserId === user.id;
}

export async function canAccessLead(user: CurrentUser, leadId: string) {
  const lead = (await db.select({ assignedUserId: leads.assignedUserId }).from(leads).where(eq(leads.id, leadId)).limit(1))[0];
  return !!lead && canSeeLead(user, lead);
}
