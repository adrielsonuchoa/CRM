'use client';

import { useState, useTransition, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { saveSettingsAction } from './actions';
import {
  startWorkerAction,
  pauseWorkerAction,
  testChromeConnectionAction,
  testMetaIntegrationAction,
} from './actions-automation';
import {
  CheckCircle2, AlertTriangle, KeyRound, BrainCircuit, ClipboardList, User,
  Bot, RefreshCw, Play, Pause, Radio, ShieldCheck, Share2
} from 'lucide-react';

type SettingsData = {
  id: string;
  name: string | null;
  commercialName: string | null;
  instagram: string | null;
  whatsapp: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  territory: string | null;
  representedCompany: string | null;
  role: string | null;
  institutionalText: string | null;
  aiAnalysisModel: string | null;
  aiMessageModel: string | null;
  dailyQueueSize: number | null;
  minScoreForQueue: number | null;
  prospectingCities: string | null;
  prospectingSegments: string | null;
  prospectingSearchTerms: string | null;
  prospectingSources: string | null;
  maxProfilesPerRun: number | null;
  maxApprovedLeadsPerDay: number | null;
  minActionIntervalSeconds: number | null;
  ignorePrivateProfiles: boolean | null;
  ignoreAlreadyAnalyzed: boolean | null;
  ignoreExistingLeads: boolean | null;
  ignoreAlreadyContacted: boolean | null;
  ignoreDuplicates: boolean | null;
  prospectionDryRun: boolean | null;
  autoReplyEnabled: boolean | null;
  followUpDays: number | null;
  maxFollowUps: number | null;
  operationalMode: string | null;
};

type WorkerStatusState = {
  status: 'ATIVO' | 'PAUSADO' | 'PROCESSANDO' | 'AGUARDANDO' | 'ERRO' | 'DESCONECTADO';
  chromeConnected: boolean;
  instagramProfile: string | null;
  automationsActive: boolean;
  dailyLimit: number;
  sentToday: number;
  queueSize: number;
  activity: string | null;
  dryRun: boolean;
  lastError: string | null;
};

type MetaStatusState = {
  configured: boolean;
  tokenStatus: 'VALID' | 'INVALID' | 'NOT_CONFIGURED';
  webhookActive: boolean;
  message?: string;
};

export function SettingsForm({
  initialSettings,
  openAiConfigured,
  initialWorkerStatus,
  initialMetaConfig,
}: {
  initialSettings: SettingsData | null;
  openAiConfigured: boolean;
  initialWorkerStatus: WorkerStatusState;
  initialMetaConfig: { configured: boolean; webhookActive: boolean; hasToken: boolean };
}) {
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Worker State
  const [workerStatus, setWorkerStatus] = useState<WorkerStatusState>(initialWorkerStatus);
  const [isStartingWorker, setIsStartingWorker] = useState(false);
  const [isPausingWorker, setIsPausingWorker] = useState(false);
  const [isTestingChrome, setIsTestingChrome] = useState(false);
  const [chromeFeedback, setChromeFeedback] = useState<string | null>(null);

  // Meta API State
  const [metaStatus, setMetaStatus] = useState<MetaStatusState>({
    configured: initialMetaConfig.configured,
    tokenStatus: initialMetaConfig.hasToken ? 'VALID' : 'NOT_CONFIGURED',
    webhookActive: initialMetaConfig.webhookActive,
  });
  const [isTestingMeta, setIsTestingMeta] = useState(false);
  const [metaFeedback, setMetaFeedback] = useState<string | null>(null);

  const s = initialSettings;

  function listDefault(value: string | null | undefined) {
    if (!value) return '';
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.join('\n') : value;
    } catch {
      return value;
    }
  }

  function sourceEnabled(source: string) {
    const configured = listDefault(s?.prospectingSources).trim();
    if (!configured) return source === 'GEOAPIFY';
    return configured.split(/\r?\n|,/).map((item) => item.trim()).includes(source);
  }

  async function handleSubmit(formData: FormData) {
    setFeedback(null);
    startTransition(async () => {
      const res = await saveSettingsAction(formData);
      if (res.success) {
        setFeedback({ type: 'success', message: 'Configurações salvas com sucesso!' });
      } else {
        setFeedback({ type: 'error', message: res.error ?? 'Falha ao salvar configurações.' });
      }
    });
  }

  const handleStartWorker = async () => {
    setIsStartingWorker(true);
    try {
      const res = await startWorkerAction();
      if (res.success) {
        setWorkerStatus((prev) => ({ ...prev, status: 'ATIVO', automationsActive: true, activity: res.message ?? 'Worker iniciado.' }));
        setFeedback({ type: 'success', message: res.message ?? 'Automação iniciada.' });
      } else {
        setWorkerStatus((prev) => ({ ...prev, status: 'ERRO', lastError: res.error ?? 'Falha ao iniciar worker.' }));
        setFeedback({ type: 'error', message: res.error ?? 'Falha ao iniciar worker.' });
      }
    } finally {
      setIsStartingWorker(false);
    }
  };

  const handlePauseWorker = async () => {
    setIsPausingWorker(true);
    try {
      const res = await pauseWorkerAction();
      if (res.success) {
        setWorkerStatus((prev) => ({ ...prev, status: 'PAUSADO', automationsActive: false, activity: 'Pausado manualmente' }));
        setFeedback({ type: 'success', message: 'Automação pausada.' });
      }
    } finally {
      setIsPausingWorker(false);
    }
  };

  const handleTestChrome = async () => {
    setIsTestingChrome(true);
    setChromeFeedback(null);
    const res = await testChromeConnectionAction();
    setIsTestingChrome(false);
    if (res.connected) {
      setChromeFeedback(res.username
        ? `Chrome conectado. Sessão Instagram detectada: @${res.username}.`
        : res.error ?? 'Chrome conectado, mas a sessão do Instagram não foi detectada.');
      setWorkerStatus((prev) => ({ ...prev, chromeConnected: true, instagramProfile: res.username }));
    } else {
      setChromeFeedback(res.error || 'Falha ao conectar ao Chrome.');
      setWorkerStatus((prev) => ({ ...prev, chromeConnected: false, status: 'DESCONECTADO' }));
    }
  };

  const handleTestMeta = async () => {
    setIsTestingMeta(true);
    setMetaFeedback(null);
    const res = await testMetaIntegrationAction();
    setIsTestingMeta(false);
    setMetaStatus((prev) => ({
      ...prev,
      tokenStatus: res.status,
    }));
    setMetaFeedback(res.message);
  };

  return (
    <form action={handleSubmit} className="space-y-10 max-w-3xl">
      {/* Feedback */}
      {feedback && (
        <div className={`flex items-center gap-3 rounded-lg p-4 text-sm border ${feedback.type === 'success'
            ? 'bg-green-50 text-green-800 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800'
            : 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800'
          }`}>
          {feedback.type === 'success'
            ? <CheckCircle2 className="w-5 h-5 shrink-0" />
            : <AlertTriangle className="w-5 h-5 shrink-0" />}
          {feedback.message}
        </div>
      )}

      {/* Section: Representative */}
      <section className="space-y-6">
        <div className="flex items-center gap-2">
          <User className="w-5 h-5 text-blue-600" />
          <h2 className="text-xl font-semibold">Representante</h2>
        </div>
        <Separator />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nome Completo</Label>
            <Input id="name" name="name" defaultValue={s?.name ?? ''} placeholder="Seu nome" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="commercialName">Nome Comercial</Label>
            <Input id="commercialName" name="commercialName" defaultValue={s?.commercialName ?? ''} placeholder="Ex: Sirrus Maceió" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="role">Cargo</Label>
            <Input id="role" name="role" defaultValue={s?.role ?? ''} placeholder="Representante Comercial" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="representedCompany">Empresa Representada</Label>
            <Input id="representedCompany" name="representedCompany" defaultValue={s?.representedCompany ?? 'Sirrus'} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="instagram">Instagram</Label>
            <Input id="instagram" name="instagram" defaultValue={s?.instagram ?? ''} placeholder="@seu_perfil" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="whatsapp">WhatsApp</Label>
            <Input id="whatsapp" name="whatsapp" defaultValue={s?.whatsapp ?? ''} placeholder="82999999999" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Telefone</Label>
            <Input id="phone" name="phone" defaultValue={s?.phone ?? ''} placeholder="(82) 99999-9999" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" name="email" type="email" defaultValue={s?.email ?? ''} placeholder="seuemail@sirrus.com.br" />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="institutionalText">Texto Institucional</Label>
          <Textarea
            id="institutionalText"
            name="institutionalText"
            defaultValue={s?.institutionalText ?? ''}
            placeholder="Representante comercial autorizado da Sirrus em Maceió/AL."
            className="min-h-[80px] resize-none"
          />
        </div>
      </section>

      {/* Section: Browser Worker & Automação Instagram */}
      <section className="space-y-6">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-blue-600" />
          <h2 className="text-xl font-semibold">Automação Instagram (Browser Worker)</h2>
        </div>
        <Separator />

        <div className="rounded-lg border bg-neutral-50 dark:bg-neutral-900/50 p-5 space-y-4">
          {workerStatus.dryRun && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
              MODO DE TESTE ativo: pesquisa, analise e mensagens funcionam; envios reais ficam bloqueados.
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-neutral-500 block text-xs">Status do Worker</span>
              <span className="font-semibold flex items-center gap-1.5 mt-1">
                {workerStatus.status === 'PROCESSANDO' && <Badge className="bg-blue-600">Processando</Badge>}
                {workerStatus.status === 'ATIVO' && <Badge className="bg-green-600">Ativo</Badge>}
                {workerStatus.status === 'AGUARDANDO' && <Badge className="bg-green-600">Aguardando</Badge>}
                {workerStatus.status === 'PAUSADO' && <Badge variant="secondary">Pausado</Badge>}
                {workerStatus.status === 'DESCONECTADO' && <Badge variant="destructive">Desconectado</Badge>}
                {workerStatus.status === 'ERRO' && <Badge variant="destructive">Erro</Badge>}
              </span>
            </div>

            <div>
              <span className="text-neutral-500 block text-xs">Chrome (CDP)</span>
              <span className="font-medium mt-1 block">
                {workerStatus.chromeConnected ? (
                  <span className="text-green-600 font-semibold flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Conectado
                  </span>
                ) : (
                  <span className="text-red-500 font-semibold flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> Desconectado
                  </span>
                )}
              </span>
            </div>

            <div>
              <span className="text-neutral-500 block text-xs">Perfil Configurado</span>
              <span className="font-medium mt-1 block truncate">
                {workerStatus.instagramProfile ? `@${workerStatus.instagramProfile}` : 'Não informado'}
              </span>
            </div>

            <div>
              <span className="text-neutral-500 block text-xs">Enviados Hoje / Limite</span>
              <span className="font-medium mt-1 block">
                {workerStatus.sentToday} / {workerStatus.dailyLimit} DMs
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              type="button"
              size="sm"
              onClick={handleStartWorker}
              disabled={isStartingWorker || isPausingWorker || workerStatus.automationsActive}
              className="bg-green-600 hover:bg-green-700 text-white gap-1.5"
            >
              <Play className="w-4 h-4" /> {isStartingWorker ? 'INICIANDO...' : 'INICIAR'}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handlePauseWorker}
              disabled={isStartingWorker || isPausingWorker || !workerStatus.automationsActive}
              className="gap-1.5"
            >
              <Pause className="w-4 h-4" /> {isPausingWorker ? 'PAUSANDO...' : 'PAUSAR'}
            </Button>

            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={handleTestChrome}
              disabled={isTestingChrome}
              className="gap-1.5"
            >
              <RefreshCw className={`w-4 h-4 ${isTestingChrome ? 'animate-spin' : ''}`} /> TESTAR CONEXÃO
            </Button>
          </div>

          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
            <p className="font-semibold">Validação da sessão</p>
            <p className="mt-1">Mantenha o Instagram aberto no Chrome iniciado com CDP. O worker reutiliza essa sessão e não fecha o navegador.</p>
          </div>

          {chromeFeedback && (
            <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300 bg-white dark:bg-neutral-800 p-2.5 rounded border">
              {chromeFeedback}
            </p>
          )}

          {workerStatus.lastError && (
            <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 p-2.5 rounded border border-red-200 dark:border-red-900">
              ⚠️ {workerStatus.lastError}
            </p>
          )}
          {workerStatus.activity && (
            <p className="text-xs text-neutral-600 dark:text-neutral-300 bg-white dark:bg-neutral-800 p-2.5 rounded border">
              Atividade atual: {workerStatus.activity}
            </p>
          )}
        </div>
      </section>

      {/* Section: Meta API & Webhook */}
      <section className="space-y-6">
        <div className="flex items-center gap-2">
          <Share2 className="w-5 h-5 text-blue-600" />
          <h2 className="text-xl font-semibold">Integração Meta / Instagram Graph API</h2>
        </div>
        <Separator />

        <div className="rounded-lg border p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-neutral-500 block text-xs">Meta API</span>
              <span className="font-semibold mt-1 block">
                {metaStatus.configured ? (
                  <Badge className="bg-blue-600">CONFIGURADA</Badge>
                ) : (
                  <Badge variant="secondary">NÃO CONFIGURADA</Badge>
                )}
              </span>
            </div>

            <div>
              <span className="text-neutral-500 block text-xs">Token Graph API</span>
              <span className="font-semibold mt-1 block">
                {metaStatus.tokenStatus === 'VALID' && <Badge className="bg-green-600">VÁLIDO</Badge>}
                {metaStatus.tokenStatus === 'INVALID' && <Badge variant="destructive">INVÁLIDO</Badge>}
                {metaStatus.tokenStatus === 'NOT_CONFIGURED' && <Badge variant="secondary">NÃO CONFIGURADO</Badge>}
              </span>
            </div>

            <div>
              <span className="text-neutral-500 block text-xs">Webhook Receiver</span>
              <span className="font-semibold mt-1 block">
                {metaStatus.webhookActive ? (
                  <Badge className="bg-green-600">ATIVO</Badge>
                ) : (
                  <Badge variant="secondary">INATIVO</Badge>
                )}
              </span>
            </div>
          </div>

          <div className="pt-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleTestMeta}
              disabled={isTestingMeta}
              className="gap-1.5"
            >
              <ShieldCheck className={`w-4 h-4 ${isTestingMeta ? 'animate-spin' : ''}`} /> TESTAR INTEGRAÇÃO
            </Button>
          </div>

          {metaFeedback && (
            <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300 bg-white dark:bg-neutral-800 p-2.5 rounded border">
              {metaFeedback}
            </p>
          )}

          <p className="text-xs text-neutral-500">
            Credenciais Meta (`META_ACCESS_TOKEN`, `META_APP_SECRET`) são lidas com segurança via variáveis de ambiente no servidor e nunca expostas no cliente.
          </p>
        </div>
      </section>

      {/* Section: AI */}
      <section className="space-y-6">
        <div className="flex items-center gap-2">
          <BrainCircuit className="w-5 h-5 text-blue-600" />
          <h2 className="text-xl font-semibold">Inteligência Artificial (OpenAI)</h2>
        </div>
        <Separator />

        <div className="rounded-lg border p-4 space-y-2">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-neutral-500" />
            <span className="font-medium text-sm">OpenAI API Key</span>
            {openAiConfigured
              ? <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-950/30 dark:text-green-300">✓ Configurada</Badge>
              : <Badge variant="destructive">Não Configurada</Badge>}
          </div>
          <p className="text-xs text-neutral-500">
            A chave de API é lida do arquivo <code className="bg-neutral-100 dark:bg-neutral-800 px-1 rounded">.env</code> como <code className="bg-neutral-100 dark:bg-neutral-800 px-1 rounded">OPENAI_API_KEY</code>.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="aiAnalysisModel">Modelo para Análise</Label>
            <select
              id="aiAnalysisModel"
              name="aiAnalysisModel"
              defaultValue={s?.aiAnalysisModel ?? 'gpt-4o-mini'}
              className="w-full border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-2 bg-white dark:bg-neutral-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="gpt-4o-mini">gpt-4o-mini (Econômico)</option>
              <option value="gpt-4o">gpt-4o (Avançado)</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="aiMessageModel">Modelo para Mensagens</Label>
            <select
              id="aiMessageModel"
              name="aiMessageModel"
              defaultValue={s?.aiMessageModel ?? 'gpt-4o-mini'}
              className="w-full border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-2 bg-white dark:bg-neutral-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="gpt-4o-mini">gpt-4o-mini (Econômico)</option>
              <option value="gpt-4o">gpt-4o (Avançado)</option>
            </select>
          </div>
        </div>
      </section>

      {/* Section: Prospecting */}
      <section className="space-y-6">
        <div className="flex items-center gap-2">
          <ClipboardList className="w-5 h-5 text-blue-600" />
          <h2 className="text-xl font-semibold">Parâmetros de Prospecção</h2>
        </div>
        <Separator />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="dailyQueueSize">Leads por dia na fila</Label>
            <Input id="dailyQueueSize" name="dailyQueueSize" type="number" min="1" max="50" defaultValue={s?.dailyQueueSize ?? 10} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="minScoreForQueue">Score mínimo para fila</Label>
            <Input id="minScoreForQueue" name="minScoreForQueue" type="number" min="0" max="100" defaultValue={s?.minScoreForQueue ?? 0} />
          </div>
        </div>
      </section>

      <section className="space-y-6">
        <div className="flex items-center gap-2">
          <ClipboardList className="w-5 h-5 text-blue-600" />
          <h2 className="text-xl font-semibold">Criterios avancados de prospeccao</h2>
        </div>
        <Separator />
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="prospectionDryRun" defaultChecked={s?.prospectionDryRun ?? true} className="h-4 w-4" />
            MODO DE TESTE: gerar fila e mensagens sem enviar contatos reais
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-3 space-y-2">
            <Label>Fonte de prospecção</Label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                ['GEOAPIFY', 'Geoapify Places'],
                ['INSTAGRAM', 'Instagram'],
                ['MANUAL', 'Lista manual'],
              ].map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <input type="checkbox" name="prospectingSources" value={value} defaultChecked={sourceEnabled(value)} className="h-4 w-4" />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="prospectingCities">Cidades / regioes</Label>
            <Textarea id="prospectingCities" name="prospectingCities" defaultValue={listDefault(s?.prospectingCities) || 'Maceio, AL'} className="min-h-[110px]" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="prospectingSegments">Segmentos / nichos</Label>
            <Textarea id="prospectingSegments" name="prospectingSegments" defaultValue={listDefault(s?.prospectingSegments) || 'Restaurante\nPizzaria\nHamburgueria\nBar\nCafeteria'} className="min-h-[110px]" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="prospectingSearchTerms">Termos de pesquisa</Label>
            <Textarea id="prospectingSearchTerms" name="prospectingSearchTerms" defaultValue={listDefault(s?.prospectingSearchTerms) || 'restaurante maceio\npizzaria maceio\ndelivery maceio'} className="min-h-[110px]" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="maxProfilesPerRun">Maximo de perfis por execucao</Label>
            <Input id="maxProfilesPerRun" name="maxProfilesPerRun" type="number" min="1" max="200" defaultValue={s?.maxProfilesPerRun ?? 20} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="maxApprovedLeadsPerDay">Maximo de leads aprovados por dia</Label>
            <Input id="maxApprovedLeadsPerDay" name="maxApprovedLeadsPerDay" type="number" min="1" max="100" defaultValue={s?.maxApprovedLeadsPerDay ?? 5} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="minActionIntervalSeconds">Intervalo minimo entre acoes (segundos)</Label>
            <Input id="minActionIntervalSeconds" name="minActionIntervalSeconds" type="number" min="15" max="3600" defaultValue={s?.minActionIntervalSeconds ?? 90} />
          </div>
        </div>
        <div className="space-y-2 rounded-md border p-3">
          <Label htmlFor="manualLeadCsv">Importar lista manual (CSV)</Label>
          <Input id="manualLeadCsv" name="manualLeadCsv" type="file" accept=".csv,text/csv" />
          <p className="text-xs text-neutral-500">Colunas: nome, instagram, telefone, website, cidade, segmento.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          {[
            ['ignorePrivateProfiles', 'Ignorar perfil privado', s?.ignorePrivateProfiles ?? true],
            ['ignoreAlreadyAnalyzed', 'Ignorar perfis ja analisados', s?.ignoreAlreadyAnalyzed ?? true],
            ['ignoreExistingLeads', 'Ignorar perfis ja existentes', s?.ignoreExistingLeads ?? true],
            ['ignoreAlreadyContacted', 'Ignorar perfis ja contatados', s?.ignoreAlreadyContacted ?? true],
            ['ignoreDuplicates', 'Ignorar duplicados', s?.ignoreDuplicates ?? true],
            ['autoReplyEnabled', 'Resposta automatica desativada por padrao', s?.autoReplyEnabled ?? false],
          ].map(([name, label, checked]) => (
            <label key={name as string} className="flex items-center gap-2 rounded-md border px-3 py-2">
              <input type="checkbox" name={name as string} defaultChecked={Boolean(checked)} className="h-4 w-4" />
              <span>{label as string}</span>
            </label>
          ))}
        </div>
      </section>

      <div className="pt-2 pb-8">
        <Button type="submit" disabled={isPending} className="bg-blue-600 hover:bg-blue-700 text-white px-8">
          {isPending ? 'Salvando...' : 'Salvar Configurações'}
        </Button>
      </div>
    </form>
  );
}
