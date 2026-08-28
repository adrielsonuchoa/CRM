import { db } from '@/db';
import { settings } from '@/db/schema';
import { SettingsForm } from './settings-form';
import { getWorkerStatus } from '@/lib/browser-worker';
import { getMetaApiStatusConfig } from '@/lib/meta-api';

export const metadata = {
  title: 'Configurações | Sirrus CRM',
  description: 'Configure o perfil do representante, automação de Instagram e integrações Meta API.',
};

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const result = await db.select().from(settings).limit(1);
  const currentSettings = result[0] ?? null;
  const openAiConfigured = !!(process.env.OPENAI_API_KEY?.trim());

  const workerStatus = await getWorkerStatus();
  const metaConfig = getMetaApiStatusConfig();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Configurações</h1>
        <p className="text-neutral-500">
          Gerencie o perfil do representante, automação do Playwright (Browser Worker) e integrações Meta.
        </p>
      </div>

      <SettingsForm
        initialSettings={currentSettings}
        openAiConfigured={openAiConfigured}
        initialWorkerStatus={workerStatus}
        initialMetaConfig={metaConfig}
      />
    </div>
  );
}
