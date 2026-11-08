'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { checkGoogleMapsSearchAction, startGoogleMapsSearchAction } from './google-maps-actions';

const NICHES = ['restaurante', 'lanchonete', 'bar', 'pizzaria', 'hamburgueria', 'padaria', 'cafeteria', 'açaí', 'sorveteria', 'self-service'];
const STORAGE_KEY = 'crm-google-maps-job';
const POLL_MS = 10000;

type RunningJob = { jobId: string; keyword: string; startedAt: number };
type Summary = { encontrados: number; criados: number; atualizados: number; ignorados: number; erros: string[] };

function readStoredJob(): RunningJob | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as RunningJob : null;
  } catch {
    return null;
  }
}

function storeJob(job: RunningJob | null) {
  try {
    if (job) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(job));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // sem localStorage (aba privada): so perde o acompanhamento ao recarregar
  }
}

export function GoogleMapsPanel({ defaultCity }: { defaultCity: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [cidade, setCidade] = useState(defaultCity);
  const [bairro, setBairro] = useState('');
  const [nicho, setNicho] = useState('restaurante');
  const [job, setJob] = useState<RunningJob | null>(null);
  const [status, setStatus] = useState<string>('pending');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const [elapsedMin, setElapsedMin] = useState(0);

  // Retoma o acompanhamento de uma busca iniciada antes de um F5 (lido
  // depois da hidratacao: o localStorage nao existe no servidor).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = readStoredJob();
      if (stored) setJob(stored);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const check = useCallback(async (current: RunningJob) => {
    setElapsedMin(Math.max(0, Math.floor((Date.now() - current.startedAt) / 60000)));
    const res = await checkGoogleMapsSearchAction(current.jobId);
    if (!res.success) {
      setError(res.error);
      return;
    }
    setStatus(res.status);
    if (res.status === 'ok' && res.resultado) {
      setSummary(res.resultado);
      setJob(null);
      storeJob(null);
      setOpen(true);
      router.refresh();
    } else if (res.status === 'failed') {
      setError('A busca falhou no Google Maps Scraper.');
      setJob(null);
      storeJob(null);
    }
  }, [router]);

  useEffect(() => {
    if (!job) return;
    const first = window.setTimeout(() => void check(job), 1000);
    const timer = window.setInterval(() => void check(job), POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [job, check]);

  const handleStart = async () => {
    setError(null);
    setSummary(null);
    setIsStarting(true);
    const res = await startGoogleMapsSearchAction({ cidade, bairro: bairro || undefined, nicho });
    setIsStarting(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    const started = { jobId: res.jobId, keyword: res.keyword, startedAt: Date.now() };
    setStatus('pending');
    setElapsedMin(0);
    setJob(started);
    storeJob(started);
  };

  return (
    <>
      <Button variant="outline" onClick={() => { setError(null); setOpen(true); }}>
        {job ? <Loader2 className="w-4 h-4 mr-2 animate-spin text-blue-600" /> : <MapPin className="w-4 h-4 mr-2" />}
        {job ? 'Google Maps: buscando...' : 'Google Maps'}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="p-5 gap-5 sm:max-w-md">
          <DialogHeader className="pr-6">
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="w-5 h-5 text-blue-600" />
              Buscar no Google Maps
            </DialogTitle>
            <DialogDescription>
              Estabelecimentos encontrados entram como leads (telefone, e-mail, WhatsApp, Instagram e Facebook). Quem já existe é atualizado, sem duplicar.
            </DialogDescription>
          </DialogHeader>

          {job ? (
            <div className="space-y-2 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                Buscando &quot;{job.keyword}&quot;
              </p>
              <p className="text-neutral-500">
                {status === 'working' ? 'O scraper está coletando os dados' : 'Aguardando o scraper iniciar'} · {elapsedMin} min.
                Costuma levar de 3 a 10 minutos; pode fechar esta janela, a busca continua.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="gmaps-cidade">Cidade</Label>
                <Input id="gmaps-cidade" value={cidade} onChange={(e) => setCidade(e.target.value)} placeholder="Maceió" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gmaps-bairro">Bairro (opcional)</Label>
                <Input id="gmaps-bairro" value={bairro} onChange={(e) => setBairro(e.target.value)} placeholder="Ponta Verde" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gmaps-nicho">Nicho</Label>
                <Input id="gmaps-nicho" list="gmaps-nichos" value={nicho} onChange={(e) => setNicho(e.target.value)} placeholder="pizzaria" />
                <datalist id="gmaps-nichos">
                  {NICHES.map((value) => <option key={value} value={value} />)}
                </datalist>
              </div>
            </div>
          )}

          {summary && (
            <div className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900 dark:border-green-900 dark:bg-green-950/30 dark:text-green-200">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                {summary.encontrados} encontrados: {summary.criados} novos, {summary.atualizados} atualizados, {summary.ignorados} ignorados.
                {summary.erros.length > 0 && ` ${summary.erros.length} com erro.`}
              </span>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <DialogFooter>
            {!job && (
              <Button onClick={handleStart} disabled={isStarting || cidade.trim().length < 2 || nicho.trim().length < 2}>
                {isStarting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <MapPin className="w-4 h-4 mr-2" />}
                {isStarting ? 'Iniciando...' : 'Buscar'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
