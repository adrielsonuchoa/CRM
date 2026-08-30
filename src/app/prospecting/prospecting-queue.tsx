'use client';

import { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { analyzeLeadAction, generateMessageAction } from '@/app/actions/ai';
import { markMessageSent, doNotContactLead, clearAllLeadsAction } from '@/app/actions';
import { cancelPreparedDmAction, confirmPreparedDmAction, previewInstagramProfileAction, sendFirstDmAction } from '@/app/settings/actions-automation';
import {
  AtSign, BrainCircuit, MessageSquareText, CheckCircle, Send,
  SkipForward, Copy, Check, AlertTriangle, RefreshCw, BanIcon, Bot, X
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
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [message, setMessage] = useState('');
  const [strategy, setStrategy] = useState('Consultiva');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDoNotContactDialog, setShowDoNotContactDialog] = useState(false);
  const [isAutoSending, setIsAutoSending] = useState(false);
  const [isConfirmingDm, setIsConfirmingDm] = useState(false);
  const [showInstagramPanel, setShowInstagramPanel] = useState(false);
  const [dmStatus, setDmStatus] = useState<'IDLE' | 'VIEWING' | 'CONNECTING' | 'PREPARED' | 'SENT' | 'ERROR'>('IDLE');
  const [instagramScreenshot, setInstagramScreenshot] = useState<string | null>(null);

  const clearError = () => setError(null);

  const resetDmPanel = () => {
    setShowInstagramPanel(false);
    setInstagramScreenshot(null);
    setDmStatus('IDLE');
    setIsAutoSending(false);
    setIsConfirmingDm(false);
  };

  const handleClearAll = async () => {
    if (!window.confirm("Deseja realmente limpar todos os leads e atividades do banco?")) return;
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
      setError(res.error ?? 'Não foi possível analisar este lead. Verifique se a OpenAI API está configurada.');
    }
    setIsAnalyzing(false);
  };

  const handleGenerateMessage = async () => {
    if (leads.length === 0 || currentIndex >= leads.length) return;
    const currentLead = leads[currentIndex];
    if (isGenerating) return;
    clearError();
    setIsGenerating(true);
    const res = await generateMessageAction(currentLead.id, strategy);
    if (res.success && res.message) {
      setMessage(res.message);
    } else {
      setError(res.error ?? 'Não foi possível gerar a mensagem. Verifique se a OpenAI API está configurada.');
    }
    setIsGenerating(false);
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
      await cancelPreparedDmAction(currentLead.id);
      resetDmPanel();
      setMessage('');
      setCurrentIndex(prev => prev + 1);
    } else {
      setError(res.error ?? 'Falha ao registrar envio.');
    }
    setIsSending(false);
  };

  const handleSkip = async () => {
    clearError();
    const skippedLead = leads[currentIndex];
    if (skippedLead) await cancelPreparedDmAction(skippedLead.id);
    resetDmPanel();
    setMessage('');
    setCurrentIndex(prev => prev + 1);
  };

  const handlePreviewInstagram = async () => {
    if (!currentLead || isAutoSending) return;
    clearError();
    setShowInstagramPanel(true);
    setDmStatus('CONNECTING');
    setInstagramScreenshot(null);
    setIsAutoSending(true);
    const res = await previewInstagramProfileAction(currentLead.id);
    setIsAutoSending(false);
    if (res.success && res.screenshot) {
      setInstagramScreenshot(res.screenshot);
      setDmStatus('VIEWING');
    } else {
      setDmStatus('ERROR');
      setError(res.error || 'Não foi possível visualizar o perfil do Instagram.');
    }
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
    const res = await sendFirstDmAction(currentLead.id, message.trim() || undefined);
    setIsAutoSending(false);
    if (res.success && res.prepared) {
      if (res.message) setMessage(res.message);
      setInstagramScreenshot(res.screenshot ?? null);
      setDmStatus('PREPARED');
    } else {
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
      await cancelPreparedDmAction(currentLead.id);
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
  const normalizedInstagram = currentLead?.instagramUsername?.replace(/^@/, '') ?? null;

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-neutral-500 border-2 border-dashed rounded-xl bg-neutral-50 dark:bg-neutral-900/50 space-y-4">
        <CheckCircle className="w-14 h-14 text-green-500" />
        <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">Fila concluída!</h2>
        <p className="mt-1">Nenhum lead prioritário restante na fila de hoje.</p>
        <Button variant="destructive" size="sm" onClick={handleClearAll}>
          Limpar Todos os Leads
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <div className="flex justify-end">
        <Button variant="destructive" size="sm" onClick={handleClearAll}>
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
      <Card className="border-2 border-neutral-200 dark:border-neutral-800 shadow-lg min-w-0">
        <CardHeader className="bg-neutral-50 dark:bg-neutral-900/60 border-b border-neutral-200 dark:border-neutral-800 rounded-t-xl">
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
              <div className="flex flex-wrap gap-3 mt-2 text-sm text-neutral-500">
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
              <div className={`text-4xl font-black ${currentLead!.leadScore != null && currentLead!.leadScore >= 80 ? 'text-blue-600' : currentLead!.leadScore != null && currentLead!.leadScore >= 60 ? 'text-green-600' : 'text-neutral-400'}`}>
                {currentLead!.leadScore ?? '—'}
              </div>
              <div className="text-xs text-neutral-500 uppercase font-bold tracking-wider">Score /100</div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-6 space-y-6">
          {/* Info + Analysis grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left: Info */}
            <div className="space-y-3">
              <h3 className="font-semibold text-base border-b border-neutral-200 dark:border-neutral-800 pb-2">Informações</h3>
              <ul className="space-y-2 text-sm">
                {[
                  ['Categoria', currentLead!.category],
                  ['Subcategoria', currentLead!.subcategory],
                  ['Delivery', currentLead!.hasDelivery ? 'Sim ✓' : currentLead!.hasDelivery === false ? 'Não' : '?'],
                  ['Salão', currentLead!.hasDiningRoom ? 'Sim ✓' : currentLead!.hasDiningRoom === false ? 'Não' : '?'],
                  ['Garçons', currentLead!.hasWaiters ? 'Sim ✓' : currentLead!.hasWaiters === false ? 'Não' : '?'],
                ].map(([label, value]) => (
                  <li key={label} className="flex justify-between">
                    <span className="text-neutral-500">{label}</span>
                    <span className="font-medium">{value ?? '—'}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Right: AI Analysis */}
            <div className="space-y-3">
              <h3 className="font-semibold text-base border-b border-neutral-200 dark:border-neutral-800 pb-2">Análise de IA</h3>
              {currentLead!.qualificationStatus ? (
                <div className="space-y-3">
                  <Badge variant={currentLead!.leadScore != null && currentLead!.leadScore > 80 ? 'default' : 'secondary'}>
                    {currentLead!.qualificationStatus}
                  </Badge>
                  {painPoints.length > 0 && (
                    <div>
                      <p className="text-xs text-neutral-500 mb-2 font-semibold uppercase tracking-wide">Possíveis Necessidades</p>
                      <div className="flex flex-wrap gap-1.5">
                        {painPoints.map((pp) => (
                          <Badge key={pp} variant="outline" className="text-xs bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/20 dark:text-orange-300">
                            {pp}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  <button
                    onClick={handleAnalyze}
                    disabled={isAnalyzing}
                    className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-700 disabled:opacity-50"
                  >
                    <RefreshCw className="w-3 h-3" />
                    {isAnalyzing ? 'Reanalisando...' : 'Reanalisar'}
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-36 bg-neutral-100 dark:bg-neutral-800/50 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700">
                  <p className="text-sm text-neutral-500 mb-3">Lead não analisado pela IA</p>
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
              <h3 className="font-semibold text-base">Mensagem de Abordagem</h3>
              <div className="flex items-center gap-2">
                <select
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value)}
                  className="text-sm border border-neutral-200 dark:border-neutral-700 rounded-md px-2 py-1.5 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="Consultiva">Consultiva</option>
                  <option value="Local">Local (Maceió)</option>
                  <option value="Problema">Focada em Problema</option>
                  <option value="Direta">Direta</option>
                </select>
                <Button onClick={handleGenerateMessage} disabled={isGenerating} size="sm" variant="secondary">
                  <MessageSquareText className="w-4 h-4 mr-2" />
                  {isGenerating ? 'Gerando...' : message ? 'Regenerar' : 'Gerar com IA'}
                </Button>
              </div>
            </div>

            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Gere uma mensagem com IA ou escreva aqui. Você pode editar antes de enviar."
              className="min-h-[130px] text-base resize-none"
            />
            <p className="text-xs text-neutral-400">
              💡 Modo Assistido: copie a mensagem, abra o Instagram, envie manualmente e clique em &quot;Marcar como Enviada&quot;.
            </p>
          </div>
        </CardContent>

        <CardFooter className="bg-neutral-50 dark:bg-neutral-900/60 border-t border-neutral-200 dark:border-neutral-800 rounded-b-xl p-4 flex flex-wrap justify-between gap-3">
          <div className="flex gap-2">
            <Button variant="ghost" onClick={handleSkip} size="sm">
              <SkipForward className="w-4 h-4 mr-1.5" />
              Pular
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
              onClick={() => setShowDoNotContactDialog(true)}
            >
              <BanIcon className="w-4 h-4 mr-1.5" />
              Não Contatar
            </Button>
          </div>

          <div className="flex gap-2 flex-wrap">
            {normalizedInstagram ? (
              <Button variant="outline" size="sm" onClick={handlePreviewInstagram} disabled={isAutoSending}>
                <AtSign className="w-4 h-4 mr-1.5" />
                Visualizar perfil
              </Button>
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
        <Card className="overflow-hidden border-neutral-300 shadow-lg xl:sticky xl:top-4">
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
              {dmStatus === 'PREPARED' && 'Mensagem digitada — aguardando sua confirmação'}
              {dmStatus === 'SENT' && 'Mensagem enviada e registrada no CRM'}
              {dmStatus === 'ERROR' && 'Não foi possível preparar a conversa'}
              {dmStatus === 'IDLE' && 'Clique em “Preparar DM” para abrir a conversa'}
            </div>

            {instagramScreenshot ? (
              <div className="aspect-[4/3] rounded-lg border bg-cover bg-top shadow-inner" style={{ backgroundImage: `url(${instagramScreenshot})` }} role="img" aria-label="Visualização atual do Instagram Direct" />
            ) : (
              <div className="flex aspect-[4/3] flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-neutral-50 text-center text-neutral-500 dark:bg-neutral-900">
                {dmStatus === 'CONNECTING' ? <RefreshCw className="h-8 w-8 animate-spin text-pink-500" /> : <AtSign className="h-10 w-10 text-pink-500" />}
                <p className="max-w-64 text-sm">A visualização do Direct aparecerá aqui, sem sair do CRM.</p>
              </div>
            )}

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Mensagem no chat</p>
              <Textarea value={message} onChange={(event) => setMessage(event.target.value)} className="min-h-28 resize-none" placeholder="A mensagem será digitada aqui e no Instagram Direct." />
            </div>
            <Button className="w-full bg-blue-600 text-white hover:bg-blue-700" onClick={handleConfirmDm} disabled={dmStatus !== 'PREPARED' || !message.trim() || isConfirmingDm}>
              {isConfirmingDm ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              {isConfirmingDm ? 'Confirmando...' : 'Confirmar e enviar agora'}
            </Button>
            <p className="text-center text-[11px] text-neutral-400">O sistema só pressiona Enter depois desta confirmação.</p>
          </CardContent>
        </Card>
      )}
      </div>

      <div className="text-center text-sm text-neutral-500">
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
    </div>
  );
}
