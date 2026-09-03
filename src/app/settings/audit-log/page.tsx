import { redirect } from 'next/navigation';
import { desc } from 'drizzle-orm';
import { db } from '@/db';
import { auditLogs } from '@/db/schema';
import { getCurrentUser, userHasPermission } from '@/lib/auth-helpers';
import { AuditLogClient } from './audit-log-client';

export const metadata = {
  title: 'Logs de Auditoria | Sirrus CRM',
};

export const dynamic = 'force-dynamic';

// Traz só os últimos N registros — suficiente pra auditar o dia a dia sem
// carregar a tabela inteira a cada visita. Dá pra paginar de verdade no
// banco depois, se o volume justificar.
const RECENT_LOGS_LIMIT = 500;

export default async function AuditLogPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser || !userHasPermission(currentUser, 'AUDIT_LOG_VIEW')) {
    redirect('/');
  }

  const rows = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(RECENT_LOGS_LIMIT);

  const logsForClient = rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    userName: row.userName,
    action: row.action,
    category: row.category,
    entityType: row.entityType,
    entityId: row.entityId,
    description: row.description,
    metadata: row.metadata,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Logs de Auditoria</h1>
        <p className="text-neutral-500">
          Histórico de ações sensíveis realizadas no sistema — quem fez, o quê e quando. Mostrando os {RECENT_LOGS_LIMIT} registros mais recentes.
        </p>
      </div>

      <AuditLogClient initialLogs={logsForClient} />
    </div>
  );
}
