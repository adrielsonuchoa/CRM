'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, Circle, Play, Square } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { WorkerLogEntry, WorkerStatus } from '@/lib/browser-worker';
import { fetchWorkerLogAction, fetchWorkerStatusAction, pauseWorkerAction, startWorkerAction } from './settings/actions-automation';

const activityLabels: Record<string, string> = {
  LEAD_CREATED: 'Lead encontrado',
  AI_ANALYSIS: 'Análise de IA concluída',
  MESSAGE_GENERATED: 'Mensagem gerada pela IA',
  MESSAGE_SENT: 'Mensagem enviada',
  MESSAGE_RECEIVED: 'Mensagem recebida',
};

export function DashboardWorkerStatus({ initialStatus, initialLogs }: { initialStatus: WorkerStatus; initialLogs: WorkerLogEntry[] }) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>(initialStatus);
  const [logs, setLogs] = useState<WorkerLogEntry[]>(initialLogs);

  const canRunWorker = workerStatus.status === 'ATIVO' || workerStatus.status === 'PROCESSANDO' || workerStatus.status === 'AGUARDANDO';

  const handleToggleWorker = async () => {
    setIsPending(true);
    try {
      const result = canRunWorker
        ? await pauseWorkerAction()
        : await startWorkerAction();

      if (!result.success) {
        return;
      }

      const nextStatus = await fetchWorkerStatusAction();
      if (nextStatus.success && nextStatus.status) {
        setWorkerStatus(nextStatus.status);
      }

      const logResult = await fetchWorkerLogAction();
      if (logResult.success) setLogs(logResult.logs);
      router.refresh();
    } finally {
      setIsPending(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const result = await fetchWorkerStatusAction();
      if (!cancelled && result.success && result.status) {
        setWorkerStatus(result.status);
        const logResult = await fetchWorkerLogAction();
        if (!cancelled && logResult.success) setLogs(logResult.logs);
        router.refresh();
      }
    };

    const interval = window.setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [router]);

  return (
    <Card className="lg:col-span-3">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2">
            <Bot className="w-5 h-5" />
            Worker e Limite Diario
          </CardTitle>
          <Button
            type="button"
            variant={canRunWorker ? 'outline' : 'default'}
            size="sm"
            className="gap-2"
            onClick={handleToggleWorker}
            disabled={isPending}
          >
            {canRunWorker ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {canRunWorker ? 'Parar IA' : 'Iniciar IA'}
          </Button>
        </div>
        <CardDescription>Status operacional atualizado automaticamente</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
        <div>
          <span className="text-neutral-500 block">Status</span>
          <span className="font-semibold">{workerStatus.status}</span>
        </div>
        <div>
          <span className="text-neutral-500 block">Chrome CDP</span>
          <span className="font-semibold">{workerStatus.chromeConnected ? 'Conectado' : 'Desconectado'}</span>
        </div>
        <div>
          <span className="text-neutral-500 block">Enviados hoje</span>
          <span className="font-semibold">{workerStatus.sentToday} / {workerStatus.dailyLimit} DMs</span>
        </div>
        <div>
          <span className="text-neutral-500 block">Atividade</span>
          <span className="font-semibold">{workerStatus.activity ?? 'Aguardando'}</span>
        </div>
        </div>

        <div className="border-t pt-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <h3 className="font-semibold">Log operacional</h3>
              <p className="text-xs text-neutral-500">Eventos do worker e da IA, atualizados automaticamente</p>
            </div>
            <span className="text-xs text-neutral-400">{logs.length} eventos</span>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-md border bg-neutral-50/70 dark:bg-neutral-900/40">
            {logs.length === 0 ? (
              <p className="p-4 text-sm text-neutral-500">Nenhuma atividade registrada ainda.</p>
            ) : (
              <div className="divide-y dark:divide-neutral-800">
                {logs.map((log) => (
                  <div key={log.id} className="flex gap-3 p-3 text-sm">
                    <Circle className="mt-1 h-2.5 w-2.5 shrink-0 fill-blue-500 text-blue-500" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium">{activityLabels[log.type] ?? log.type}</span>
                        {log.leadName && <span className="truncate text-neutral-500">{log.leadName}</span>}
                        <time className="text-xs text-neutral-400">{new Date(log.createdAt).toLocaleTimeString('pt-BR')}</time>
                      </div>
                      {log.content && <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{log.content}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
