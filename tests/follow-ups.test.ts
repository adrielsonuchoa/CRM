import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Teste de integracao contra um SQLite temporario com todas as migracoes:
// valida o ciclo de follow-ups (agendar, concluir, limite, cancelar).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-followups-'));
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db').replace(/\\/g, '/')}`;

type Modules = {
  db: typeof import('@/db').db;
  schema: typeof import('@/db/schema');
  followUps: typeof import('@/lib/follow-ups');
  orm: typeof import('drizzle-orm');
};
let m: Modules;

before(async () => {
  // Import dinamico: '@/db' cria o client no import, depois do DATABASE_URL acima.
  const { db } = await import('@/db');
  const { migrate } = await import('drizzle-orm/libsql/migrator');
  const { ensureLegacyColumns } = await import('@/db/ensure-columns');
  // Mesmo caminho do npm run db:migrate (src/db/migrate.ts).
  await migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
  await ensureLegacyColumns(db.$client);
  m = { db, schema: await import('@/db/schema'), followUps: await import('@/lib/follow-ups'), orm: await import('drizzle-orm') };
  await m.db.insert(m.schema.settings).values({ id: 'default', followUpDays: 3, maxFollowUps: 2 });
});

after(() => {
  m?.db.$client.close();
  // No Windows o arquivo pode seguir travado por instantes; e so lixo temporario.
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

async function createLead(stage = 'CONTATO REALIZADO') {
  const id = crypto.randomUUID();
  const now = new Date();
  await m.db.insert(m.schema.leads).values({ id, businessName: `Lead ${id.slice(0, 6)}`, pipelineStage: stage, createdAt: now, updatedAt: now });
  return id;
}

async function leadTasks(leadId: string) {
  const { tasks } = m.schema;
  return m.db.select().from(tasks).where(m.orm.eq(tasks.leadId, leadId)).orderBy(tasks.createdAt);
}

async function nextFollowUp(leadId: string) {
  const { leads } = m.schema;
  return (await m.db.select({ next: leads.nextFollowUpAt }).from(leads).where(m.orm.eq(leads.id, leadId)))[0].next;
}

test('computeFollowUpDueAt soma os dias configurados', () => {
  const base = new Date('2026-10-01T10:00:00');
  assert.equal(m.followUps.computeFollowUpDueAt(base, 3).getDate(), 4);
  assert.equal(m.followUps.computeFollowUpDueAt(base, 0).getDate(), 2, 'minimo de 1 dia');
});

test('primeiro contato agenda o follow-up 1 para daqui a 3 dias', async () => {
  const leadId = await createLead();
  const contactAt = new Date('2026-10-01T10:00:00');
  await m.followUps.scheduleFollowUpAfterContact(leadId, contactAt);

  const list = await leadTasks(leadId);
  assert.equal(list.length, 1);
  assert.equal(list[0].type, 'FOLLOW_UP');
  assert.equal(list[0].status, 'PENDING');
  assert.match(list[0].title, /^Follow-up 1 - /);
  assert.equal(list[0].dueAt?.getTime(), new Date('2026-10-04T10:00:00').getTime());
  assert.equal((await nextFollowUp(leadId))?.getTime(), list[0].dueAt?.getTime());
});

test('novo envio conclui o pendente e respeita o limite de 2 follow-ups', async () => {
  const leadId = await createLead();
  await m.followUps.scheduleFollowUpAfterContact(leadId); // follow-up 1
  await m.followUps.scheduleFollowUpAfterContact(leadId); // envia o 1 -> agenda o 2
  await m.followUps.scheduleFollowUpAfterContact(leadId); // envia o 2 -> limite atingido

  const list = await leadTasks(leadId);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((t) => t.status), ['DONE', 'DONE']);
  assert.equal(await nextFollowUp(leadId), null);
});

test('lead que ja respondeu nao recebe follow-up', async () => {
  const leadId = await createLead('RESPONDEU');
  await m.followUps.scheduleFollowUpAfterContact(leadId);
  assert.equal((await leadTasks(leadId)).length, 0);
});

test('cancelPendingFollowUps cancela e limpa o proximo follow-up', async () => {
  const leadId = await createLead();
  await m.followUps.scheduleFollowUpAfterContact(leadId);
  await m.followUps.cancelPendingFollowUps(leadId, 'Cancelado: lead respondeu.');

  const list = await leadTasks(leadId);
  assert.equal(list[0].status, 'CANCELED');
  assert.equal(list[0].notes, 'Cancelado: lead respondeu.');
  assert.equal(await nextFollowUp(leadId), null);
});
