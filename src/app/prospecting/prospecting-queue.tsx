'use client';

import { useState, useCallback, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { analyzeLeadActionAuthorized as analyzeLeadAction } from '@/app/actions/ai';
import { buildApproachTemplate } from '@/lib/approach-template';
import { markMessageSent, doNotContactLead, clearAllLeadsAction } from '@/app/actions';
import { cancelPreparedDmAction, confirmPreparedDmAction, getQueueInstagramAction, previewInstagramProfileAction, sendFirstDmAction, warmupQueueAction } from '@/app/settings/actions-automation';
import { buildWhatsAppUrl } from '@/lib/phone';
import {
  AtSign, BrainCircuit, MessageSquareText, CheckCircle, Send,
  SkipForward, Copy, Check, AlertTriangle, RefreshCw, BanIcon, Bot, X, MessageCircle, ExternalLink
} from 'lucide-react';

type Lead = {
  id: string;
  businessName: string;
  instagramUsername: string | null;
  neighborhood: string | null;
  category: string | null;
  subcategory: string | null;
  followers: number | null;
  phone: string | null;
  whatsapp: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  rating: number | null;
  reviewCount: number | null;
  hasDelivery: boolean | null;
  hasDiningRoom: boolean | null;
  hasWaiters: boolean | null;
  instagramActive: boolean | null;
  leadScore: number | null;
  qualificationStatus: string | null;
  notes: string | null;
  painPoints: string | null;
};

export function ProspectingQueue({ initialLeads }: { initialLeads: Lead[] }) {
  const [leads, setLeads] = useState(initialLeads);
  const [currentIndex, setCurrentIndex] = useState(0);

  // initialLeads so era capturado uma vez (useState) e nunca mais
  // atualizado, entao leads novos encontrados por uma busca direcionada em
  // andamento nunca apareciam sem um F5 manual. Ressincroniza quando o
  // conjunto de ids mudar de verdade (novo lead chegou), preservando
  // edicoes otimistas locais (ex.: handleAnalyze) quando nada mudou. Ajuste
  // de estado durante a renderizacao (padrao recomendado pelo React pra
  // "resetar estado quando uma prop muda"), em vez de useEffect + setState.
  const [syncedIds, setSyncedIds] = useState(() => initialLeads.map((lead) => lead.id).join(','));
  const incomingIds = initialLeads.map((lead) => lead.id).join(',');
  if (incomingIds !== syncedIds) {
    setSyncedIds(incomingIds);
    setLeads(initialLeads);
  }
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDoNotContactDialog, setShowDoNotContactDialog] = useState(false);
  const [showClearAllDialog, setShowClearAllDialog] = useState(false);
  const [isAutoSending, setIsAutoSending] = useState(false);
  const [isConfirmingDm, setIsConfirmingDm] = useState(false);
  const [showInstagramPanel, setShowInstagramPanel] = useState(false);
  const [dmStatus, setDmStatus] = useState<'IDLE' | 'VIEWING' | 'CONNECTING' | 'PREPARED' | 'SENT' | 'ERROR'>('IDLE');
  const [instagramScreenshot, setInstagramScreenshot] = useState<string | null>(null);

  const clearError = () => setError(null);

  // Pre-carrega o Instagram de toda a fila em segundo plano assim que ela
  // abre (ou recebe leads novos), a partir do lead atual: acha o @ de quem
  // ainda nao tem e deixa a foto do perfil em cache, pra "Preparar DM" ficar
  // instantaneo. O servidor ignora leads ja enfileirados.
  const queueIdsKey = leads.map((lead) => lead.id).join(',');
  useEffect(() => {
    const ids = queueIdsKey ? queueIdsKey.split(',') : [];
    const ordered = [...ids.slice(currentIndex), ...ids.slice(0, currentIndex)];
    if (ordered.length > 0) void warmupQueueAction(ordered).catch(() => undefined);
    // currentIndex fica de fora de proposito: so a ordem inicial importa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueIdsKey]);

  // Mostra os @ que o pre-carregamento for achando, sem recarregar a pagina.
  const missingInstagramKey = leads.filter((lead) => !lead.instagramUsername).map((lead) => lead.id).join(',');
  useEffect(() => {
    if (!missingInstagramKey) return;
    const timer = setInterval(async () => {
      const res = await getQueueInstagramAction(missingInstagramKey.split(',')).catch(() => null);
      const found = new Map((res?.leads ?? []).filter((row) => row.instagramUsername).map((row) => [row.id, row]));
      if (found.size === 0) return;
      setLeads((current) => current.map((lead) => {
        const row = found.get(lead.id);
        return row && !lead.instagramUsername
          ? { ...lead, instagramUsername: row.instagramUsername, followers: row.followers ?? lead.followers }
          : lead;
      }));
    }, 15000);
    return () => clearInterval(timer);
  }, [missingInstagramKey]);

  function applyFoundInstagram(leadId: string, instagramUsername: string | undefined) {
    if (!instagramUsername) return;
    setLeads((current) => current.map((lead) => (lead.id === leadId && lead.instagramUsername !== instagramUsername
      ? { ...lead, instagramUsername }
      : lead)));
  }

  const resetDmPanel = () => {
    setShowInstagramPanel(false);
    setInstagramScreenshot(null);
    setDmStatus('IDLE');
    setIsAutoSending(false);
    setIsConfirmingDm(false);
  };

  const handleConfirmClearAll = async () => {
    // window.confirm() nativo foi trocado por este dialog da propria
    // aplicacao: o backend mantem uma conexao Playwright permanente com essa
    // mesma aba (pro polling de status a cada 3s), e o comportamento padrao
    // do Playwright e auto-descartar qualquer dialog nativo sem um listener
    // registrado - o que podia cancelar o confirm() sozinho antes do clique
    // humano ser processado, fazendo o botao parecer que "nao faz nada".
    setShowClearAllDialog(false);
    const res = await clearAllLeadsAction();
    if (res.success) {
      resetDmPanel();
      setLeads([]);
      setCurrentIndex(0);
      setError(null);
      return;
    }
    setError(res.error || "Falha ao limpar registros.");
  };

  const handleAnalyze = async () => {
    if (leads.length === 0 || currentIndex >= leads.length) return;
    const currentLead = leads[currentIndex];
    if (isAnalyzing) return;
    clearError();
    setIsAnalyzing(true);
    const res = await analyzeLeadAction(currentLead.id);
    if (res.success && res.result) {
      const updatedLead: Lead = {
        ...currentLead,
        leadScore: res.result.score,
        qualificationStatus: res.result.qualification,
        painPoints: JSON.stringify(res.result.possibleNeeds),
      };
      const newLeads = [...leads];
      newLeads[currentIndex] = updatedLead;
      setLeads(newLeads);
    } else {
      setError(res.error ?? 'Não foi possível analisar este lead. Verifique se a Gemini API está configurada.');
    }
    setIsAnalyzing(false);
  };

  // Modelo fixo (sem IA): preenche o campo pra o usuario revisar/editar.
  const handleUseTemplate = () => {
    if (leads.length === 0 || currentIndex >= leads.length) return;
    clearError();
    setMessage(buildApproachTemplate(leads[currentIndex]));
  };

  const handleCopy = useCallback(() => {
    if (!message) return;
    navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [message]);

  const handleMarkAsSent = async () => {
    if (leads.length === 0 || currentIndex >= leads.length) return;
    const currentLead = leads[currentIndex];
    if (!message.trim() || isSending) return;
    setIsSending(true);
    const res = await markMessageSent(currentLead.id, message);
    if (res.success) {
      void cancelPreparedDmAction(currentLead.id).catch(() => undefined);
      resetDmPanel();
      setMessage('');
      setCurrentIndex(prev => prev + 1);
    } else {
      setError(res.error ?? 'Falha ao registrar envio.');
    }
    setIsSending(false);
  };

  const handleSkip = () => {
    clearError();
    const skippedLead = leads[currentIndex];
    // Atualiza a tela na hora do clique - o cancelamento da DM preparada e so
    // limpeza de bastidor (fecha um navegador de fundo, se houver, e grava um
    // log), nao algo que a proxima tela precisa esperar. Antes isso era
    // aguardado antes de avançar, entao o clique ficava "pendurado" ate essa
    // chamada de rede (banco remoto) voltar, e so entao tudo pulava de vez.
    resetDmPanel();
    setMessage('');
    setCurrentIndex(prev => prev + 1);
    if (skippedLead) void cancelPreparedDmAction(skippedLead.id).catch(() => undefined);
  };

  const handleAutoSend = async () => {
    if (leads.length === 0 || currentIndex >= leads.length) return;
    const currentLead = leads[currentIndex];
    if (isAutoSending) return;
    clearError();
    setShowInstagramPanel(true);
    setDmStatus('CONNECTING');
    setInstagramScreenshot(null);
    setIsAutoSending(true);

    // Mostra a screenshot do CACHE (se a busca ja validou esse perfil antes)
    // assim que possivel, em paralelo com a preparacao real da conversa -
    // assim o usuario ve a imagem do perfil quase na hora em vez de olhar
    // pro espaco vazio girando o tempo todo, mesmo que a conversa
    // interativa em si (obrigatoria pra poder digitar/enviar de verdade)
    // ainda leve mais alguns segundos pra ficar pronta.
    let resultadoRealChegou = false;
    void previewInstagramProfileAction(currentLead.id).then((preview) => {
      if (!resultadoRealChegou && preview.success && preview.screenshot) {
        setInstagramScreenshot(preview.screenshot);
      }
    }).catch(() => undefined);

    const res = await sendFirstDmAction(currentLead.id, message.trim() || undefined);
    resultadoRealChegou = true;
    setIsAutoSending(false);
    // O @ pode ter sido achado agora mesmo se a conversa nao abriu: atualiza
    // o card pra liberar "Visualizar perfil" e "Preparar DM".
    applyFoundInstagram(currentLead.id, 'instagramUsername' in res ? res.instagramUsername : undefined);
    if (res.success && 'prepared' in res && res.prepared) {
      if (res.message) setMessage(res.message);
      setInstagramScreenshot(res.screenshot ?? null);
      setDmStatus('PREPARED');
    } else {
      if ('screenshot' in res && res.screenshot) setInstagramScreenshot(res.screenshot);
      setDmStatus('ERROR');
      setError(res.error || 'Falha ao enviar DM via automação.');
    }
  };

  const handleConfirmDm = async () => {
    if (!currentLead || !message.trim() || isConfirmingDm) return;
    clearError();
    setIsConfirmingDm(true);
    const res = await confirmPreparedDmAction(currentLead.id, message);
    setIsConfirmingDm(false);
    if (res.success) {
      setDmStatus('SENT');
      if (res.dryRun) {
        setError('MODO DE TESTE ativo: a mensagem foi preparada, mas o envio real continua bloqueado.');
        return;
      }
      setTimeout(() => {
        resetDmPanel();
        setMessage('');
        setCurrentIndex((prev) => prev + 1);
      }, 900);
    } else {
      setDmStatus('ERROR');
      setError(res.error || 'Falha ao confirmar o envio da DM.');
    }
  };

  const handleConfirmDoNotContact = async () => {
    if (leads.length === 0 || currentIndex >= leads.length) return;
    const currentLead = leads[currentIndex];
    setShowDoNotContactDialog(false);
    const res = await doNotContactLead(currentLead.id);
    if (res.success) {
      void cancelPreparedDmAction(currentLead.id).catch(() => undefined);
      resetDmPanel();
      setMessage('');
      setCurrentIndex(prev => prev + 1);
    } else {
      setError(res.error ?? 'Falha ao marcar lead.');
    }
  };

  // Compute derived values before any conditional return
  const isEmpty = leads.length === 0 || currentIndex >= leads.length;
  const currentLead = isEmpty ? null : leads[currentIndex];
  let painPoints: string[] = [];
  try {
    if (currentLead?.painPoints) painPoints = JSON.parse(currentLead.painPoints);
  } catch {}
  const normalizedInstagram = (() => {
    if (!currentLead?.instagramUsername) return null;
    const raw = String(currentLead.instagramUsername).trim();
    const withoutAt = raw.replace(/^@/, '');
    const withoutBaseUrl = withoutAt
      .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '')
      .replace(/^https?:\/\/(?:www\.)?instagram\.com$/i, '');
    const normalized = withoutBaseUrl.split(/[/?#]/)[0].trim();
    return normalized && /^[a-zA-Z0-9._]+$/.test(normalized) ? normalized.toLowerCase() : null;
  })();
  const whatsAppUrl = currentLead ? buildWhatsAppUrl(currentLead.whatsapp ?? currentLead.phone, message) : null;

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-neutral-600 dark:text-neutral-400 border-2 border-dashed rounded-xl bg-neutral-50 dark:bg-neutral-900/50 space-y-4">
        <CheckCircle className="w-14 h-14 text-green-500" />
        <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">Fila concluída!</h2>
        <p className="mt-1">Nenhum lead prioritário restante na fila de hoje.</p>
        <Button variant="destructive" size="sm" onClick={() => setShowClearAllDialog(true)}>
          Limpar Todos os Leads
        </Button>
        <Dialog open={showClearAllDialog} onOpenChange={setShowClearAllDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-red-600" />
                Confirmar: Limpar Todos os Leads
              </DialogTitle>
              <DialogDescription>
                Deseja realmente limpar todos os leads e atividades do banco? Esta ação é irreversível.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowClearAllDialog(false)}>Cancelar</Button>
              <Button variant="destructive" onClick={handleConfirmClearAll}>Confirmar: Limpar Tudo</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <div className="flex justify-end">
        <Button variant="destructive" size="sm" onClick={() => setShowClearAllDialog(true)}>
          Limpar Todos os Leads
        </Button>
      </div>
      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded-lg p-4 text-sm">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="flex-1">{error}</div>
          <button onClick={clearError} className="text-red-600 hover:text-red-800 font-bold shrink-0">✕</button>
        </div>
      )}

      <div className={showInstagramPanel ? 'grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] gap-4 items-start' : ''}>
      <Card className="border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 shadow-md min-w-0">
        <CardHeader className="bg-neutral-100 dark:bg-neutral-900/60 border-b border-neutral-300 dark:border-neutral-800 rounded-t-xl">
          <div className="flex justify-between items-start gap-4">
            <div className="flex-1 min-w-0">
              <CardTitle className="text-2xl font-bold flex flex-wrap items-center gap-2">
                <span className="truncate">{currentLead!.businessName}</span>
                {currentLead!.instagramActive && (
                  <Badge className="bg-gradient-to-r from-pink-600 to-purple-600 text-white border-0 shrink-0">
                    Instagram Ativo
                  </Badge>
                )}
              </CardTitle>
              <div className="flex flex-wrap gap-3 mt-2 text-sm text-neutral-700 dark:text-neutral-300">
                <span>📍 {currentLead!.neighborhood ?? 'Bairro não informado'}</span>
                {(currentLead!.city || currentLead!.state) && <span>• {[currentLead!.city, currentLead!.state].filter(Boolean).join(' / ')}</span>}
                <span>•</span>
                <span>👥 {currentLead!.followers?.toLocaleString('pt-BR') ?? 0} seguidores</span>
                {currentLead!.rating != null && <span>• ⭐ {currentLead!.rating.toLocaleString('pt-BR')}{currentLead!.reviewCount != null ? ` (${currentLead!.reviewCount} avaliações)` : ''}</span>}
                {currentLead!.phone && <span>• 📞 {currentLead!.phone}</span>}
                {currentLead!.website && <span className="max-w-xs truncate">• 🌐 {currentLead!.website}</span>}
                {normalizedInstagram && (
                  <>
                    <span>•</span>
                    <span className="text-pink-600">@{normalizedInstagram}</span>
                  </>
                )}
              </div>
            </div>

            <div className="text-right shrink-0">
              <div className={`text-4xl font-black ${currentLead!.leadScore != null && currentLead!.leadScore >= 80 ? 'text-blue-600' : currentLead!.leadScore != null && currentLead!.leadScore >= 60 ? 'text-green-600' : 'text-neutral-600 dark:text-neutral-400'}`}>
                {currentLead!.leadScore ?? '—'}
              </div>
              <div className="text-xs text-neutral-600 dark:text-neutral-400 uppercase font-bold tracking-wider">Score /100</div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-6 space-y-6">
          {/* Info + Analysis grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left: Info */}
            <div className="space-y-3">
              <h3 className="font-semibold text-base text-neutral-900 dark:text-neutral-50 border-b border-neutral-300 dark:border-neutral-800 pb-2">Informações</h3>
              <ul className="space-y-2 text-sm">
                {[
                  ['Categoria', currentLead!.category],
                  ['Subcategoria', currentLead!.subcategory],
                  ['Delivery', currentLead!.hasDelivery ? 'Sim ✓' : currentLead!.hasDelivery === false ? 'Não' : '?'],
                  ['Salão', currentLead!.hasDiningRoom ? 'Sim ✓' : currentLead!.hasDiningRoom === false ? 'Não' : '?'],
                  ['Garçons', currentLead!.hasWaiters ? 'Sim ✓' : currentLead!.hasWaiters === false ? 'Não' : '?'],
                ].map(([label, value]) => (
                  <li key={label} className="flex justify-between">
                    <span className="text-neutral-600 dark:text-neutral-400">{label}</span>
                    <span className="font-semibold text-neutral-900 dark:text-neutral-50">{value ?? '—'}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Right: AI Analysis */}
            <div className="space-y-3">
              <h3 className="font-semibold text-base text-neutral-900 dark:text-neutral-50 border-b border-neutral-300 dark:border-neutral-800 pb-2">Análise de IA</h3>
              {currentLead!.qualificationStatus ? (
                <div className="space-y-3">
                  <Badge variant={currentLead!.leadScore != null && currentLead!.leadScore > 80 ? 'default' : 'secondary'}>
                    {currentLead!.qualificationStatus}
                  </Badge>
                  {painPoints.length > 0 && (
                    <div>
                      <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-2 font-semibold uppercase tracking-wide">Possíveis Necessidades</p>
                      <div className="flex flex-wrap gap-1.5">
                        {painPoints.map((pp) => (
                          <Badge key={pp} variant="outline" className="text-xs bg-orange-50 text-orange-800 border-orange-300 dark:bg-orange-950/20 dark:text-orange-300">
                            {pp}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  <button
                    onClick={handleAnalyze}
                    disabled={isAnalyzing}
                    className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400 hover:text-neutral-700 disabled:opacity-50"
                  >
                    <RefreshCw className="w-3 h-3" />
                    {isAnalyzing ? 'Reanalisando...' : 'Reanalisar'}
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-36 bg-neutral-100 dark:bg-neutral-800/50 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700">
                  <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">Lead não analisado pela IA</p>
                  <Button onClick={handleAnalyze} disabled={isAnalyzing} size="sm">
                    <BrainCircuit className="w-4 h-4 mr-2" />
                    {isAnalyzing ? 'Analisando...' : 'Analisar Lead'}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Message section */}
          <div className="space-y-3 border-t border-neutral-200 dark:border-neutral-800 pt-6">
            <div className="flex flex-wrap justify-between items-center gap-2">
              <h3 className="font-semibold text-base text-neutral-900 dark:text-neutral-50">Mensagem de Abordagem</h3>
              <Button onClick={handleUseTemplate} size="sm" variant="secondary">
                <MessageSquareText className="w-4 h-4 mr-2" />
                Usar modelo
              </Button>
            </div>

            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Escreva a mensagem aqui. Você pode editar antes de enviar."
              className="min-h-[130px] text-base text-neutral-900 dark:text-neutral-50 border-neutral-300 placeholder:text-neutral-500 resize-none"
            />
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              💡 Escreva a sua mensagem ou clique em &quot;Usar modelo&quot; para começar de um texto pronto e ajustar.
            </p>
          </div>
        </CardContent>

        <CardFooter className="bg-neutral-100 dark:bg-neutral-900/60 border-t border-neutral-300 dark:border-neutral-800 rounded-b-xl p-4 flex flex-wrap justify-between gap-3">
          <div className="flex gap-2">
            <Button variant="ghost" onClick={handleSkip} size="sm">
              <SkipForward className="w-4 h-4 mr-1.5" />
              Pular
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-950/30"
              onClick={() => setShowDoNotContactDialog(true)}
            >
              <BanIcon className="w-4 h-4 mr-1.5" />
              Não Contatar
            </Button>
          </div>

          <div className="flex gap-2 flex-wrap">
            {normalizedInstagram ? (
              // So um link de verdade pra aba do navegador ja aberta - o
              // perfil real e interativo, sem precisar de screenshot via
              // Playwright (isso ficou reservado pra quando realmente e
              // preciso, como preparar a conversa em "Preparar DM").
              <a
                href={`https://www.instagram.com/${normalizedInstagram}/`}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                <AtSign className="w-4 h-4 mr-1.5" />
                Visualizar perfil
                <ExternalLink className="w-3 h-3 ml-1.5 opacity-60" />
              </a>
            ) : (
              <Button variant="outline" size="sm" disabled title="Instagram não cadastrado">
                <AtSign className="w-4 h-4 mr-1.5" />
                Sem Instagram
              </Button>
            )}

            <Button variant="secondary" size="sm" onClick={handleCopy} disabled={!message.trim()}>
              {copied ? <Check className="w-4 h-4 mr-1.5 text-green-600" /> : <Copy className="w-4 h-4 mr-1.5" />}
              {copied ? 'Copiado!' : 'Copiar'}
            </Button>

            {whatsAppUrl ? (
              <a
                href={whatsAppUrl}
                target="whatsapp-web"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                title="Abrir conversa no WhatsApp com a mensagem preenchida"
              >
                <MessageCircle className="w-4 h-4 mr-1.5 text-green-600" />
                WhatsApp
              </a>
            ) : (
              <Button variant="outline" size="sm" disabled title="Sem telefone válido para WhatsApp">
                <MessageCircle className="w-4 h-4 mr-1.5 opacity-40" />
                Sem WhatsApp
              </Button>
            )}

            <Button
              size="sm"
              onClick={handleAutoSend}
              disabled={isAutoSending}
              variant="outline"
              className="border-blue-500 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30"
              title={normalizedInstagram
                ? 'Enviar primeira DM de forma automatizada via Playwright'
                : 'Localizar o Instagram do lead e preparar o envio automatizado'}
            >
              {isAutoSending ? (
                <RefreshCw className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Bot className="w-4 h-4 mr-1.5" />
              )}
              {isAutoSending ? 'Abrindo conversa...' : normalizedInstagram ? 'Preparar DM' : 'Buscar Instagram e preparar'}
            </Button>

            <Button
              size="sm"
              onClick={handleMarkAsSent}
              disabled={!message.trim() || isSending}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              <CheckCircle className="w-4 h-4 mr-1.5" />
              {isSending ? 'Registrando...' : 'Marcar como Enviada'}
            </Button>
          </div>
        </CardFooter>
      </Card>

      {showInstagramPanel && (
        <Card className="overflow-hidden border-neutral-300 bg-white dark:bg-neutral-950 shadow-md xl:sticky xl:top-4">
          <CardHeader className="border-b bg-gradient-to-r from-fuchsia-600 via-pink-600 to-orange-500 p-4 text-white">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-white/80 bg-white/20 font-bold">
                  {(normalizedInstagram || currentLead!.businessName).slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <CardTitle className="truncate text-base">@{normalizedInstagram || 'instagram pendente'}</CardTitle>
                  <p className="truncate text-xs text-white/80">{currentLead!.businessName}</p>
                </div>
              </div>
              <button onClick={() => setShowInstagramPanel(false)} aria-label="Fechar painel" className="rounded-full p-1 hover:bg-white/20">
                <X className="h-5 w-5" />
              </button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className={`h-2.5 w-2.5 rounded-full ${dmStatus === 'ERROR' ? 'bg-red-500' : dmStatus === 'PREPARED' ? 'bg-amber-500' : dmStatus === 'SENT' ? 'bg-green-500' : dmStatus === 'CONNECTING' ? 'animate-pulse bg-blue-500' : 'bg-neutral-300'}`} />
              {dmStatus === 'CONNECTING' && 'Carregando o Instagram em segundo plano...'}
              {dmStatus === 'VIEWING' && 'Perfil do Instagram carregado'}
              {dmStatus === 'PREPARED' && (message.trim() ? 'Mensagem digitada — aguardando sua confirmação' : 'Conversa aberta — digite a mensagem ou use o modelo')}
              {dmStatus === 'SENT' && 'Mensagem enviada e registrada no CRM'}
              {dmStatus === 'ERROR' && 'Não foi possível preparar a conversa'}
              {dmStatus === 'IDLE' && 'Clique em “Preparar DM” para abrir a conversa'}
            </div>

            {instagramScreenshot ? (
              <div className="aspect-[4/3] rounded-lg border bg-cover bg-top shadow-inner" style={{ backgroundImage: `url(${instagramScreenshot})` }} role="img" aria-label="Visualização atual do Instagram Direct" />
            ) : (
              <div className="flex aspect-[4/3] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 text-center text-neutral-600 dark:text-neutral-400 dark:bg-neutral-900">
                {dmStatus === 'CONNECTING' ? <RefreshCw className="h-8 w-8 animate-spin text-pink-500" /> : <AtSign className="h-10 w-10 text-pink-500" />}
                <p className="max-w-64 text-sm">A visualização do Direct aparecerá aqui, sem sair do CRM.</p>
              </div>
            )}

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">Mensagem no chat</p>
              <Textarea value={message} onChange={(event) => setMessage(event.target.value)} className="min-h-28 text-neutral-900 dark:text-neutral-50 border-neutral-300 placeholder:text-neutral-500 resize-none" placeholder="A mensagem será digitada aqui e no Instagram Direct." />
            </div>
            <Button className="w-full bg-blue-600 text-white hover:bg-blue-700" onClick={handleConfirmDm} disabled={dmStatus !== 'PREPARED' || !message.trim() || isConfirmingDm}>
              {isConfirmingDm ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              {isConfirmingDm ? 'Confirmando...' : 'Confirmar e enviar agora'}
            </Button>
            <p className="text-center text-[11px] text-neutral-600 dark:text-neutral-400">O sistema só pressiona Enter depois desta confirmação.</p>
          </CardContent>
        </Card>
      )}
      </div>

      <div className="text-center text-sm text-neutral-600 dark:text-neutral-400">
        Lead <strong>{currentIndex + 1}</strong> de <strong>{leads.length}</strong> na fila de hoje
      </div>

      {/* Do Not Contact Confirmation Dialog */}
      <Dialog open={showDoNotContactDialog} onOpenChange={setShowDoNotContactDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-600" />
              Confirmar: Não Contatar
            </DialogTitle>
            <DialogDescription>
              Tem certeza que deseja marcar <strong>{currentLead!.businessName}</strong> como &quot;Não Contatar&quot;?
              <br />Este lead não aparecerá mais na fila de prospecção automaticamente.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDoNotContactDialog(false)}>Cancelar</Button>
            <Button variant="destructive" onClick={handleConfirmDoNotContact}>
              <BanIcon className="w-4 h-4 mr-2" />
              Confirmar: Não Contatar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear All Leads Confirmation Dialog */}
      <Dialog open={showClearAllDialog} onOpenChange={setShowClearAllDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-600" />
              Confirmar: Limpar Todos os Leads
            </DialogTitle>
            <DialogDescription>
              Deseja realmente limpar todos os leads e atividades do banco? Esta ação é irreversível.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClearAllDialog(false)}>Cancelar</Button>
            <Button variant="destructive" onClick={handleConfirmClearAll}>Confirmar: Limpar Tudo</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
