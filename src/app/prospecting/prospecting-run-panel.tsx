'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Search, Loader2, X } from 'lucide-react';
import type { TargetedProspectingProgress } from '@/lib/browser-worker';
import {
  fetchWorkerStatusAction,
  startTargetedProspectingAction,
  cancelTargetedProspectingAction,
} from '@/app/settings/actions-automation';

type FinishedSummary = {
  target: number;
  validated: number;
  discarded: number;
  instagramFound: number;
  message: string;
};

export function ProspectingRunPanel({ defaultDesiredCount }: { defaultDesiredCount: number }) {
  const router = useRouter();
  const [desiredCount, setDesiredCount] = useState(defaultDesiredCount);
  const [isStarting, setIsStarting] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [progress, setProgress] = useState<TargetedProspectingProgress | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [finished, setFinished] = useState<FinishedSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previousValidated = useRef<number | null>(null);
  const wasRunning = useRef(false);
  const lastProgress = useRef<TargetedProspectingProgress | null>(null);
  const lastPageRefreshAt = useRef(0);

  // router.refresh() reexecuta a página inteira no servidor (a query da
  // fila, etc.) - chamar isso a cada poll de 3s sempre que o contador de
  // validados mudasse deixava a página travando/piscando durante uma busca
  // ativa. Limitado a no máximo 1x a cada 8s (a barra de progresso do modal
  // em si já atualiza a cada poll via estado local, sem precisar disso).
  const PAGE_REFRESH_THROTTLE_MS = 8000;
  const throttledPageRefresh = useCallback(() => {
    const now = Date.now();
    if (now - lastPageRefreshAt.current < PAGE_REFRESH_THROTTLE_MS) return;
    lastPageRefreshAt.current = now;
    router.refresh();
  }, [router]);

  const refreshStatus = useCallback(async () => {
    const result = await fetchWorkerStatusAction();
    if (!result.success || !result.status) return;

    const run = result.status.targetedRun;
    const currentActivity = result.status.activity ?? null;
    setActivity(currentActivity);

    if (run && previousValidated.current !== null && previousValidated.current !== run.validated) {
      throttledPageRefresh();
    }
    previousValidated.current = run?.validated ?? null;

    // O run acabou de terminar (tinha progresso, agora nao tem mais) - guarda
    // um resumo final pra mostrar no modal em vez de voltar direto pro
    // formulario, e da uma ultima atualizada na fila.
    const previous = lastProgress.current;
    if (!run && wasRunning.current && previous) {
      setFinished({
        target: previous.target,
        validated: previous.validated,
        discarded: previous.discarded,
        instagramFound: previous.instagramFound,
        message: currentActivity ?? `Busca concluída: ${previous.validated}/${previous.target} leads válidos.`,
      });
      router.refresh();
    }
    wasRunning.current = !!run;
    lastProgress.current = run;
    setProgress(run);
  }, [router, throttledPageRefresh]);

  // Checagem unica ao montar: se a pagina foi recarregada com uma busca
  // ainda ativa em segundo plano (progressRunId != null no servidor), o
  // botao compacto precisa refletir isso mesmo sem o modal estar aberto.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchWorkerStatusAction();
      if (cancelled || !result.success || !result.status) return;
      if (result.status.targetedRun) {
        wasRunning.current = true;
        setProgress(result.status.targetedRun);
        setActivity(result.status.activity ?? null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // So faz polling enquanto o modal esta aberto OU ha uma busca ativa em
  // segundo plano (pro botao compacto continuar atualizando mesmo com o
  // modal fechado, sem manter um poll permanente quando nao ha nada rodando).
  const isRunning = !!progress;
  useEffect(() => {
    if (!modalOpen && !isRunning) return;
    const initialRefresh = window.setTimeout(() => void refreshStatus(), 0);
    const interval = window.setInterval(() => void refreshStatus(), 3000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
    };
  }, [modalOpen, isRunning, refreshStatus]);

  const handleOpen = () => {
    setError(null);
    setModalOpen(true);
  };

  const handleStart = async () => {
    if (isStarting) return;
    setError(null);
    setFinished(null);
    setIsStarting(true);
    try {
      const result = await startTargetedProspectingAction(desiredCount);
      if (result.success) {
        await refreshStatus();
      } else {
        setError(result.error ?? 'Não foi possível iniciar a busca.');
      }
    } finally {
      setIsStarting(false);
    }
  };

  const handleCancel = async () => {
    await cancelTargetedProspectingAction();
  };

  const target = progress?.target ?? desiredCount;
  const validated = progress?.validated ?? 0;
  const pct = target > 0 ? Math.min(100, Math.round((validated / target) * 100)) : 0;

  return (
    <div className="flex items-center gap-2">
      <Button onClick={handleOpen} disabled={isStarting} variant={isRunning ? 'outline' : 'default'}>
        {isRunning ? <Loader2 className="w-4 h-4 mr-2 animate-spin text-blue-600" /> : <Search className="w-4 h-4 mr-2" />}
        {isRunning ? `Buscando leads... ${validated}/${target}` : 'Buscar Leads'}
      </Button>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="p-5 gap-5 sm:max-w-md">
          {isRunning ? (
            <>
              <DialogHeader className="pr-6">
                <DialogTitle className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                  Buscando leads
                </DialogTitle>
                <DialogDescription>{activity ?? 'Preparando a busca...'}</DialogDescription>
              </DialogHeader>

              <div className="space-y-5">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm font-medium">
                    <span>Prospectando</span>
                    <span>{validated}/{target}</span>
                  </div>
                  <div className="h-2.5 w-full rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
                    <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="rounded-md border p-3.5">
                    <span className="text-neutral-500 block text-xs">Instagram encontrados</span>
                    <span className="font-semibold text-base">{progress?.instagramFound ?? 0}</span>
                  </div>
                  <div className="rounded-md border p-3.5">
                    <span className="text-neutral-500 block text-xs">Validados</span>
                    <span className="font-semibold text-base text-green-600">{progress?.validated ?? 0}</span>
                  </div>
                  <div className="rounded-md border p-3.5">
                    <span className="text-neutral-500 block text-xs">Descartados</span>
                    <span className="font-semibold text-base text-red-500">{progress?.discarded ?? 0}</span>
                  </div>
                  <div className="rounded-md border p-3.5">
                    <span className="text-neutral-500 block text-xs">Pendentes</span>
                    <span className="font-semibold text-base">{progress?.pending ?? 0}</span>
                  </div>
                </div>
              </div>

              <DialogFooter className="-mx-5 -mb-5 p-5">
                {/* DialogFooter empilha em coluna REVERSA em telas estreitas
                    (o ultimo botao no DOM vira o primeiro visualmente) - a
                    ordem aqui e proposital pra que a acao destrutiva
                    (Cancelar) fique por baixo/menos em evidencia nesse caso,
                    em vez de "Continuar em segundo plano" (acao segura). */}
                <Button variant="destructive" onClick={handleCancel}>
                  <X className="w-4 h-4 mr-1.5" />
                  Cancelar busca
                </Button>
                <Button variant="outline" onClick={() => setModalOpen(false)}>Continuar em segundo plano</Button>
              </DialogFooter>
            </>
          ) : finished ? (
            <>
              <DialogHeader className="pr-6">
                <DialogTitle>Busca concluída</DialogTitle>
                <DialogDescription>{finished.message}</DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="rounded-md border p-3.5">
                  <span className="text-neutral-500 block text-xs">Instagram encontrados</span>
                  <span className="font-semibold text-base">{finished.instagramFound}</span>
                </div>
                <div className="rounded-md border p-3.5">
                  <span className="text-neutral-500 block text-xs">Validados</span>
                  <span className="font-semibold text-base text-green-600">{finished.validated}/{finished.target}</span>
                </div>
                <div className="rounded-md border p-3.5 col-span-2">
                  <span className="text-neutral-500 block text-xs">Descartados sem contato</span>
                  <span className="font-semibold text-base text-red-500">{finished.discarded}</span>
                </div>
              </div>

              <DialogFooter className="-mx-5 -mb-5 p-5">
                <Button variant="outline" onClick={() => setFinished(null)}>Buscar mais</Button>
                <Button onClick={() => { setFinished(null); setModalOpen(false); }}>Fechar</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader className="pr-6">
                <DialogTitle>Buscar leads</DialogTitle>
                <DialogDescription>
                  Conta apenas leads com contato verificável — Instagram validado ou telefone/WhatsApp.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2">
                <Label htmlFor="desiredCount">Quantidade de leads desejados</Label>
                <Input
                  id="desiredCount"
                  type="number"
                  min={1}
                  max={200}
                  value={desiredCount}
                  onChange={(e) => setDesiredCount(Math.max(1, Number(e.target.value) || 1))}
                  autoFocus
                />
                {error && <p className="text-sm text-red-600">{error}</p>}
              </div>

              <DialogFooter className="-mx-5 -mb-5 p-5">
                <Button variant="outline" onClick={() => setModalOpen(false)}>Cancelar</Button>
                <Button onClick={handleStart} disabled={isStarting}>
                  {isStarting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
                  {isStarting ? 'Iniciando...' : 'Buscar Leads'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
