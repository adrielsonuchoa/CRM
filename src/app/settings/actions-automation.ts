'use server';

import {
  getWorkerStatus,
  startWorker,
  pauseWorker,
  checkChromeConnection,
  sendFirstDmViaBrowser,
  confirmPreparedDmViaBrowser,
  cancelPreparedDmViaBrowser,
  previewInstagramProfileViaBrowser,
  enrichLeadViaBrowser,
  testWorkerReadiness,
  getRecentWorkerActivities,
} from '@/lib/browser-worker';
import { testMetaConnection, getMetaApiStatusConfig } from '@/lib/meta-api';
import { revalidatePath } from 'next/cache';
import { requirePermission, requireUser, AuthError, ForbiddenError, type CurrentUser } from '@/lib/auth-helpers';
import type { PermissionKey } from '@/lib/permissions';
import { logAudit } from '@/lib/audit-log';

function authErrorMessage(error: unknown): string | null {
  if (error instanceof AuthError || error instanceof ForbiddenError) return error.message;
  return null;
}

type Gate = { user: CurrentUser; denied: null } | { user: null; denied: { success: false; error: string } };

// Faz a checagem de permissão e devolve uma resposta pronta pra retornar
// direto ({success:false, error}) quando negado — em vez de deixar
// AuthError/ForbiddenError estourarem sem tratamento até o cliente (o que
// funcionaria pra bloquear, mas devolveria um erro genérico e feio em vez
// de uma mensagem clara).
async function gate(key: PermissionKey): Promise<Gate> {
  try {
    const user = await requirePermission(key);
    return { user, denied: null };
  } catch (error) {
    const message = authErrorMessage(error);
    if (!message) throw error;
    return { user: null, denied: { success: false, error: message } };
  }
}

async function gateAnyUser(): Promise<Gate> {
  try {
    const user = await requireUser();
    return { user, denied: null };
  } catch (error) {
    const message = authErrorMessage(error);
    if (!message) throw error;
    return { user: null, denied: { success: false, error: message } };
  }
}

// Status/telemetria de leitura, exibidos globalmente (barra de progresso do
// worker em toda página autenticada) — exige sessão válida, mas não uma
// permissão específica, pra não depender de um toggle de permissão granular
// pra mostrar/esconder um elemento de chrome do app.
export async function fetchWorkerStatusAction() {
  const { denied } = await gateAnyUser();
  if (denied) return denied;
  try {
    const status = await getWorkerStatus();
    return { success: true, status };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function fetchWorkerLogAction() {
  const { denied } = await gate('DASHBOARD_VIEW');
  if (denied) return { ...denied, logs: [] };
  try {
    return { success: true, logs: await getRecentWorkerActivities() };
  } catch (error: any) {
    return { success: false, logs: [], error: error.message };
  }
}

export async function startWorkerAction() {
  const { user, denied } = await gate('AUTOMATION_START');
  if (denied) return denied;

  const result = await startWorker();
  await logAudit({
    userId: user.id,
    userName: user.name,
    action: 'AUTOMATION_STARTED',
    category: 'AUTOMATION',
    description: 'Iniciou a automação de prospecção.',
  });
  revalidatePath('/');
  revalidatePath('/settings');
  revalidatePath('/prospecting');
  revalidatePath('/leads');
  return result;
}

export async function pauseWorkerAction() {
  const { user, denied } = await gate('AUTOMATION_PAUSE');
  if (denied) return denied;

  const result = await pauseWorker();
  await logAudit({
    userId: user.id,
    userName: user.name,
    action: 'AUTOMATION_PAUSED',
    category: 'AUTOMATION',
    description: 'Pausou a automação de prospecção.',
  });
  revalidatePath('/');
  revalidatePath('/settings');
  return result;
}

export async function testChromeConnectionAction() {
  const { denied } = await gate('AUTOMATION_TEST_CONNECTION');
  if (denied) return denied;

  const readiness = await testWorkerReadiness();
  const result = await checkChromeConnection();
  return { ...result, readiness };
}

export async function enrichLeadAction(leadId: string) {
  const { user, denied } = await gate('LEAD_ENRICH');
  if (denied) return denied;

  const result = await enrichLeadViaBrowser(leadId);
  await logAudit({
    userId: user.id,
    userName: user.name,
    action: 'LEAD_ENRICHED',
    category: 'LEADS',
    entityType: 'LEAD',
    entityId: leadId,
    description: 'Buscou dados de Instagram / enriqueceu o lead.',
  });
  revalidatePath('/prospecting');
  revalidatePath('/leads');
  revalidatePath(`/leads/${leadId}`);
  return result;
}

export async function sendFirstDmAction(leadId: string, message?: string) {
  const { user, denied } = await gate('INSTAGRAM_SEND_MESSAGE');
  if (denied) return denied;

  const result = await sendFirstDmViaBrowser(leadId, message);
  await logAudit({
    userId: user.id,
    userName: user.name,
    action: 'INSTAGRAM_DM_SENT',
    category: 'MESSAGES',
    entityType: 'LEAD',
    entityId: leadId,
    description: 'Enviou a primeira mensagem pelo Instagram.',
  });
  revalidatePath('/prospecting');
  revalidatePath('/leads');
  revalidatePath(`/leads/${leadId}`);
  return result;
}

export async function confirmPreparedDmAction(leadId: string, message: string) {
  const { user, denied } = await gate('INSTAGRAM_SEND_MESSAGE');
  if (denied) return denied;

  const result = await confirmPreparedDmViaBrowser(leadId, message);
  await logAudit({
    userId: user.id,
    userName: user.name,
    action: 'INSTAGRAM_DM_CONFIRMED',
    category: 'MESSAGES',
    entityType: 'LEAD',
    entityId: leadId,
    description: 'Confirmou e enviou a DM preparada pelo Instagram.',
  });
  revalidatePath('/prospecting');
  revalidatePath('/pipeline');
  revalidatePath(`/leads/${leadId}`);
  return result;
}

export async function previewInstagramProfileAction(leadId: string) {
  const { denied } = await gate('INSTAGRAM_PREVIEW_PROFILE');
  if (denied) return denied;
  return previewInstagramProfileViaBrowser(leadId);
}

export async function cancelPreparedDmAction(leadId: string) {
  const { user, denied } = await gate('INSTAGRAM_CANCEL_DM');
  if (denied) return denied;

  const result = await cancelPreparedDmViaBrowser(leadId);
  await logAudit({
    userId: user.id,
    userName: user.name,
    action: 'INSTAGRAM_DM_CANCELLED',
    category: 'MESSAGES',
    entityType: 'LEAD',
    entityId: leadId,
    description: 'Cancelou a DM preparada pelo Instagram.',
  });
  return result;
}

export async function testMetaIntegrationAction() {
  const { denied } = await gate('INTEGRATION_TEST_META');
  if (denied) return denied;
  return testMetaConnection();
}

// Status de configuração (não expõe segredos, só se está configurado ou
// não), usado tanto no dashboard quanto em Configurações — basta sessão
// válida.
export async function fetchMetaStatusConfigAction() {
  const { denied } = await gateAnyUser();
  if (denied) return denied;
  const config = getMetaApiStatusConfig();
  return { success: true, config };
}
