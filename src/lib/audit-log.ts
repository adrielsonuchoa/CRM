import { db } from '@/db';
import { auditLogs } from '@/db/schema';
import crypto from 'crypto';

export type AuditCategory =
  | 'AUTH'
  | 'USERS'
  | 'LEADS'
  | 'PIPELINE'
  | 'MESSAGES'
  | 'AUTOMATION'
  | 'SETTINGS';

// Nenhuma chave que "pareça" um segredo pode ir em metadata, em nenhuma
// profundidade do objeto — regra explícita: senha, token, chave de API,
// cookie ou segredo genérico nunca vão pro log de auditoria, nem por
// engano/copy-paste de um objeto maior.
const FORBIDDEN_METADATA_KEY_PATTERN =
  /(password|senha|token|secret|api[_-]?key|cookie|authorization|passwordhash)/i;

function assertNoSecrets(value: unknown, path = ''): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_METADATA_KEY_PATTERN.test(key)) {
        throw new Error(
          `logAudit: campo "${path}${path ? '.' : ''}${key}" parece um segredo (senha/token/api key/cookie) e não pode ir em metadata de audit_logs.`,
        );
      }
      assertNoSecrets(val, `${path}${path ? '.' : ''}${key}`);
    }
  }
}

export type LogAuditInput = {
  userId: string | null;
  // Nome do usuário no momento da ação, gravado à parte (desnormalizado)
  // pra o log continuar legível mesmo se o usuário for renomeado ou
  // desativado depois.
  userName: string | null;
  action: string; // ex.: AUTH_LOGIN, AUTH_LOGIN_FAILED, USER_CREATED, LEAD_STAGE_CHANGED
  category: AuditCategory;
  entityType?: string; // ex.: LEAD, USER, SETTINGS
  entityId?: string;
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Grava uma entrada no log de auditoria. Lança erro — não falha em
 * silêncio — se `metadata` contiver uma chave que pareça um segredo: é
 * melhor a ação quebrar em desenvolvimento (e o erro apontar o campo exato)
 * do que um token acabar persistido em produção.
 *
 * Chame isso a partir das próprias server actions, depois que a ação já
 * foi autorizada e executada, nunca antes — o log deve refletir o que de
 * fato aconteceu.
 */
export async function logAudit(input: LogAuditInput): Promise<void> {
  if (input.metadata) {
    assertNoSecrets(input.metadata);
  }

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    userId: input.userId,
    userName: input.userName,
    action: input.action,
    category: input.category,
    entityType: input.entityType,
    entityId: input.entityId,
    description: input.description,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    createdAt: new Date(),
  });
}
