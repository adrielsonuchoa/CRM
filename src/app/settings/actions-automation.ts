'use server';

import {
  getWorkerStatus,
  startWorker,
  pauseWorker,
  checkChromeConnection,
  sendFirstDmViaBrowser,
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

export async function startWorkerAction() {
  const result = startWorker();
  revalidatePath('/settings');
  return result;
}

export async function pauseWorkerAction() {
  const result = pauseWorker();
  revalidatePath('/settings');
  return result;
}

export async function testChromeConnectionAction() {
  const result = await checkChromeConnection();
  return result;
}

export async function sendFirstDmAction(leadId: string) {
  const result = await sendFirstDmViaBrowser(leadId);
  revalidatePath('/prospecting');
  revalidatePath('/leads');
  revalidatePath(`/leads/${leadId}`);
  return result;
}

export async function testMetaIntegrationAction() {
  const result = await testMetaConnection();
  return result;
}

export async function fetchMetaStatusConfigAction() {
  const config = getMetaApiStatusConfig();
  return { success: true, config };
}
