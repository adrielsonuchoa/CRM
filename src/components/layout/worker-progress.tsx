'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, CircleAlert, LoaderCircle, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { WorkerStatus } from '@/lib/browser-worker';
import { fetchWorkerStatusAction, pauseWorkerAction, startWorkerAction } from '@/app/settings/actions-automation';

const RUNNING_STATUS = new Set(['ATIVO', 'PROCESSANDO', 'AGUARDANDO']);

export function WorkerProgress() {
  const router = useRouter();
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [isToggling, setIsToggling] = useState(false);
  const previousActivity = useRef<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const result = await fetchWorkerStatusAction();
    if (!result.success || !result.status) return;

    setStatus(result.status);
    if (previousActivity.current !== null && previousActivity.current !== result.status.activity) {
      router.refresh();
    }
    previousActivity.current = result.status.activity;
  }, [router]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refreshStatus(), 0);
    const interval = window.setInterval(() => void refreshStatus(), 3000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
    };
  }, [refreshStatus]);

  const running = status ? RUNNING_STATUS.has(status.status) : false;

  const handleToggle = async () => {
    if (isToggling) return;
    setIsToggling(true);
    try {
      const result = running ? await pauseWorkerAction() : await startWorkerAction();
      if (result.success) await refreshStatus();
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-neutral-200 bg-white px-6 py-2.5 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {status?.previewScreenshot && (
            <div
              className="h-10 w-14 shrink-0 rounded border bg-cover bg-top shadow-sm"
              style={{ backgroundImage: `url(${status.previewScreenshot})` }}
              role="img"
              aria-label={status.currentLeadName ? `Perfil em processamento: ${status.currentLeadName}` : 'Último perfil processado'}
            />
          )}
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${running ? 'bg-blue-100 text-blue-600 dark:bg-blue-950' : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800'}`}>
            {status?.status === 'PROCESSANDO' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : status?.status === 'ERRO' ? <CircleAlert className="h-4 w-4 text-red-500" /> : <Bot className="h-4 w-4" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide">Automação IA</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${running ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : status?.status === 'ERRO' ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'}`}>
                {status?.status ?? 'CARREGANDO'}
              </span>
            </div>
            <p className="max-w-[70vw] truncate text-xs text-neutral-500">
              {status?.currentLeadName ? `${status.currentLeadName} · ` : ''}{status?.activity ?? 'Consultando o status da automação...'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {status && <span className="hidden text-xs text-neutral-500 sm:inline">{status.sentToday}/{status.dailyLimit} DMs hoje</span>}
          <Button type="button" size="sm" variant={running ? 'outline' : 'default'} onClick={handleToggle} disabled={isToggling || !status} className="h-8 gap-2">
            {running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {isToggling ? 'Aguarde...' : running ? 'Pausar IA' : 'Iniciar IA'}
          </Button>
        </div>
      </div>
      {status?.lastError && <p className="mt-1 truncate pl-11 text-xs text-red-600">{status.lastError}</p>}
    </div>
  );
}
