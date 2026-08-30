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

export async function fetchWorkerStatusAction() {
  try {
    const status = await getWorkerStatus();
    return { success: true, status };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function fetchWorkerLogAction() {
  try {
    return { success: true, logs: await getRecentWorkerActivities() };
  } catch (error: any) {
    return { success: false, logs: [], error: error.message };
  }
}

export async function startWorkerAction() {
  const result = await startWorker();
  revalidatePath('/');
  revalidatePath('/settings');
  revalidatePath('/prospecting');
  revalidatePath('/leads');
  return result;
}

export async function pauseWorkerAction() {
  const result = await pauseWorker();
  revalidatePath('/');
  revalidatePath('/settings');
  return result;
}

export async function testChromeConnectionAction() {
  const readiness = await testWorkerReadiness();
  const result = await checkChromeConnection();
  return { ...result, readiness };
}

export async function enrichLeadAction(leadId: string) {
  const result = await enrichLeadViaBrowser(leadId);
  revalidatePath('/prospecting');
  revalidatePath('/leads');
  revalidatePath(`/leads/${leadId}`);
  return result;
}

export async function sendFirstDmAction(leadId: string, message?: string) {
  const result = await sendFirstDmViaBrowser(leadId, message);
  revalidatePath('/prospecting');
  revalidatePath('/leads');
  revalidatePath(`/leads/${leadId}`);
  return result;
}

export async function confirmPreparedDmAction(leadId: string, message: string) {
  const result = await confirmPreparedDmViaBrowser(leadId, message);
  revalidatePath('/prospecting');
  revalidatePath('/pipeline');
  revalidatePath(`/leads/${leadId}`);
  return result;
}

export async function previewInstagramProfileAction(leadId: string) {
  return previewInstagramProfileViaBrowser(leadId);
}

export async function cancelPreparedDmAction(leadId: string) {
  return cancelPreparedDmViaBrowser(leadId);
}

export async function testMetaIntegrationAction() {
  const result = await testMetaConnection();
  return result;
}

export async function fetchMetaStatusConfigAction() {
  const config = getMetaApiStatusConfig();
  return { success: true, config };
}
