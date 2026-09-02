'use client';

import { useState, useTransition } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { addLeadNote, updateLeadStage } from '@/app/actions';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  AtSign, Phone, MessageCircle, ExternalLink, MapPin,
  CheckCircle2, AlertTriangle, Clock, Tag, StickyNote, Activity
} from 'lucide-react';

const STAGES = [
  'NOVO', 'PESQUISANDO', 'QUALIFICADO', 'PRONTO PARA CONTATO',
  'CONTATO REALIZADO', 'RESPONDEU', 'CONVERSANDO', 'INTERESSADO',
  'WHATSAPP', 'DEMONSTRAÇÃO AGENDADA', 'DEMONSTRAÇÃO REALIZADA',
  'PROPOSTA', 'NEGOCIAÇÃO', 'CLIENTE', 'PERDIDO', 'NÃO CONTATAR',
];

const ACTIVITY_LABELS: Record<string, string> = {
  LEAD_CREATED: 'Lead criado',
  AI_ANALYSIS: 'Análise de IA',
  MESSAGE_GENERATED: 'Mensagem gerada',
  MESSAGE_SENT: 'Mensagem enviada',
  MESSAGE_RECEIVED: 'Resposta recebida',
  NOTE: 'Nota adicionada',
  PIPELINE_CHANGED: 'Pipeline alterado',
  WHATSAPP_MOVED: 'Movido para WhatsApp',
  DEMO_SCHEDULED: 'Demo agendada',
  PROPOSAL: 'Proposta enviada',
};

const ACTIVITY_COLORS: Record<string, string> = {
  AI_ANALYSIS: 'bg-purple-100 text-purple-800 dark:bg-purple-950/30 dark:text-purple-300',
  MESSAGE_SENT: 'bg-blue-100 text-blue-800 dark:bg-blue-950/30 dark:text-blue-300',
  MESSAGE_RECEIVED: 'bg-green-100 text-green-800 dark:bg-green-950/30 dark:text-green-300',
  PIPELINE_CHANGED: 'bg-orange-100 text-orange-800 dark:bg-orange-950/30 dark:text-orange-300',
  NOTE: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  default: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
};

function normalizePhone(phone: string | null) {
  if (!phone) return null;
  return phone.replace(/[\s\(\)\-\.]/g, '');
}

function normalizeInstagram(ig: string | null) {
  if (!ig) return null;

  const raw = String(ig).trim();
  const withoutAt = raw.replace(/^@/, '');
  const withoutBaseUrl = withoutAt
    .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '')
    .replace(/^https?:\/\/(?:www\.)?instagram\.com$/i, '');
  const normalized = withoutBaseUrl.split(/[/?#]/)[0].trim();

  if (!normalized || !/^[a-zA-Z0-9._]+$/.test(normalized)) return null;
  return normalized.toLowerCase();
}

type Lead = {
  id: string; businessName: string; instagramUsername: string | null; phone: string | null;
  whatsapp: string | null; email: string | null; address: string | null;
  neighborhood: string | null; city: string | null; state: string | null;
  category: string | null; subcategory: string | null; followers: number | null;
  instagramActive: boolean | null; hasDelivery: boolean | null; hasDiningRoom: boolean | null;
  hasWaiters: boolean | null; hasMultipleUnits: boolean | null;
  estimatedSize: string | null; currentSystem: string | null; painPoints: string | null;
  notes: string | null; source: string | null; leadScore: number | null;
  qualificationStatus: string | null; pipelineStage: string;
  firstContactAt: Date | null; lastContactAt: Date | null; doNotContact: boolean | null;
  createdAt: Date; updatedAt: Date;
};

type Activity = {
  id: string; leadId: string; type: string; channel: string | null;
  direction: string | null; content: string | null; metadata: string | null;
  createdAt: Date;
};

export function LeadDetailClient({ lead, activities }: { lead: Lead; activities: Activity[] }) {
  const [note, setNote] = useState('');
  const [selectedStage, setSelectedStage] = useState(lead.pipelineStage);
  const [isPendingNote, startNoteTransition] = useTransition();
  const [isPendingStage, startStageTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  let painPoints: string[] = [];
  try { if (lead.painPoints) painPoints = JSON.parse(lead.painPoints); } catch {}

  const normalIg = normalizeInstagram(lead.instagramUsername);
  const normalPhone = normalizePhone(lead.phone);
  const normalWa = normalizePhone(lead.whatsapp ?? lead.phone);

  function getScoreColor() {
    if (!lead.leadScore) return 'text-neutral-400';
    if (lead.leadScore >= 80) return 'text-blue-600';
    if (lead.leadScore >= 60) return 'text-green-600';
    if (lead.leadScore >= 40) return 'text-yellow-600';
    return 'text-red-500';
  }

  const handleAddNote = () => {
    if (!note.trim()) return;
    startNoteTransition(async () => {
      const res = await addLeadNote(lead.id, note.trim());
      if (res.success) {
        setNote('');
        setFeedback({ type: 'success', message: 'Nota salva com sucesso.' });
        setTimeout(() => setFeedback(null), 3000);
      } else {
        setFeedback({ type: 'error', message: res.error ?? 'Falha ao salvar nota.' });
      }
    });
  };

  const handleStageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newStage = e.target.value;
    setSelectedStage(newStage);
    startStageTransition(async () => {
      const res = await updateLeadStage(lead.id, newStage);
      if (res.success) {
        setFeedback({ type: 'success', message: `Pipeline atualizado para: ${newStage}` });
        setTimeout(() => setFeedback(null), 3000);
      } else {
        setSelectedStage(lead.pipelineStage);
        setFeedback({ type: 'error', message: res.error ?? 'Falha ao atualizar pipeline.' });
      }
    });
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-10">
      {/* Feedback */}
      {feedback && (
        <div className={`flex items-center gap-3 rounded-lg p-3 text-sm border ${feedback.type === 'success'
            ? 'bg-green-50 text-green-800 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800'
            : 'bg-red-50 text-red-800 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800'
          }`}>
          {feedback.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
          {feedback.message}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap justify-between items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-3xl font-bold tracking-tight">{lead.businessName}</h1>
            {lead.doNotContact && (
              <Badge variant="destructive">Não Contatar</Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-3 mt-2 text-sm text-neutral-500">
            {(lead.neighborhood || lead.city) && (
              <span className="flex items-center gap-1">
                <MapPin className="w-4 h-4" />
                {[lead.neighborhood, lead.city, lead.state].filter(Boolean).join(', ')}
              </span>
            )}
            {lead.category && (
              <span className="flex items-center gap-1">
                <Tag className="w-4 h-4" />
                {lead.category}{lead.subcategory ? ` · ${lead.subcategory}` : ''}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className={`text-3xl font-black ${getScoreColor()}`}>
            {lead.leadScore ?? '—'}<span className="text-base font-normal text-neutral-400">/100</span>
          </div>
          {lead.qualificationStatus && (
            <Badge variant={lead.leadScore != null && lead.leadScore > 80 ? 'default' : 'secondary'}>
              {lead.qualificationStatus}
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Main content */}
        <div className="lg:col-span-2 space-y-6">

          {/* Actions bar */}
          <Card>
            <CardContent className="p-4 flex flex-wrap gap-2">
              {normalIg ? (
                <a href={`https://instagram.com/${normalIg}`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  <AtSign className="w-4 h-4 mr-1.5" />
                  Instagram
                  <ExternalLink className="w-3 h-3 ml-1 opacity-60" />
                </a>
              ) : (
                <Button variant="outline" size="sm" disabled title="Instagram não cadastrado">
                  <AtSign className="w-4 h-4 mr-1.5 opacity-40" />
                  Sem Instagram
                </Button>
              )}

              {normalWa ? (
                <a href={`https://wa.me/55${normalWa}`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  <MessageCircle className="w-4 h-4 mr-1.5 text-green-600" />
                  WhatsApp
                  <ExternalLink className="w-3 h-3 ml-1 opacity-60" />
                </a>
              ) : (
                <Button variant="outline" size="sm" disabled title="Telefone não cadastrado">
                  <MessageCircle className="w-4 h-4 mr-1.5 opacity-40" />
                  Sem WhatsApp
                </Button>
              )}

              {normalPhone && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigator.clipboard.writeText(normalPhone)}
                  title={`Copiar telefone: ${normalPhone}`}
                >
                  <Phone className="w-4 h-4 mr-1.5" />
                  {lead.phone}
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <StickyNote className="w-5 h-5" />
                Notas
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300 bg-neutral-50 dark:bg-neutral-900/50 rounded-lg p-3 min-h-[60px]">
                {lead.notes || <span className="text-neutral-400 italic">Nenhuma nota registrada.</span>}
              </div>
              <Separator />
              <div className="space-y-2">
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Adicionar nova nota..."
                  className="min-h-[80px] resize-none"
                />
                <Button
                  size="sm"
                  onClick={handleAddNote}
                  disabled={!note.trim() || isPendingNote}
                >
                  {isPendingNote ? 'Salvando...' : 'Adicionar Nota'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Pain Points */}
          {painPoints.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Possíveis Necessidades</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {painPoints.map((pp) => (
                    <Badge key={pp} variant="outline" className="bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/20 dark:text-orange-300">
                      {pp}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Activity Timeline */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="w-5 h-5" />
                Histórico de Atividades
              </CardTitle>
            </CardHeader>
            <CardContent>
              {activities.length === 0 ? (
                <p className="text-sm text-neutral-400 italic">Nenhuma atividade registrada.</p>
              ) : (
                <div className="space-y-3">
                  {activities.map((act) => {
                    const colorClass = ACTIVITY_COLORS[act.type] ?? ACTIVITY_COLORS.default;
                    return (
                      <div key={act.id} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <div className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${colorClass}`}>
                            {ACTIVITY_LABELS[act.type] ?? act.type}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          {act.content && (
                            <p className="text-sm text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap break-words line-clamp-3">
                              {act.content}
                            </p>
                          )}
                          <p className="text-xs text-neutral-400 mt-0.5 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {format(new Date(act.createdAt), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                            {act.channel && ` · ${act.channel}`}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: Sidebar info */}
        <div className="space-y-6">
          {/* Pipeline */}
          <Card>
            <CardHeader>
              <CardTitle>Pipeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <select
                value={selectedStage}
                onChange={handleStageChange}
                disabled={isPendingStage}
                className="w-full border border-neutral-200 dark:border-neutral-700 rounded-md px-3 py-2 bg-white dark:bg-neutral-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              >
                {STAGES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              {isPendingStage && <p className="text-xs text-neutral-500">Atualizando...</p>}
            </CardContent>
          </Card>

          {/* Profile */}
          <Card>
            <CardHeader>
              <CardTitle>Perfil Operacional</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                ['Categoria', lead.category],
                ['Delivery', lead.hasDelivery ? 'Sim ✓' : lead.hasDelivery === false ? 'Não' : '?'],
                ['Salão', lead.hasDiningRoom ? 'Sim ✓' : lead.hasDiningRoom === false ? 'Não' : '?'],
                ['Garçons', lead.hasWaiters ? 'Sim ✓' : lead.hasWaiters === false ? 'Não' : '?'],
                ['Múlt. Unidades', lead.hasMultipleUnits ? 'Sim ✓' : 'Não'],
                ['Seguidores', lead.followers?.toLocaleString('pt-BR')],
                ['Sistema Atual', lead.currentSystem],
                ['Fonte', lead.source],
              ].map(([label, value]) => (
                value !== undefined && value !== null ? (
                  <div key={label} className="flex justify-between border-b border-neutral-100 dark:border-neutral-800 pb-2 last:border-0 last:pb-0">
                    <span className="text-sm text-neutral-500">{label}</span>
                    <span className="text-sm font-medium text-right">{value || '—'}</span>
                  </div>
                ) : null
              ))}
            </CardContent>
          </Card>

          {/* Dates */}
          <Card>
            <CardHeader>
              <CardTitle>Datas</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {[
                ['Criado em', lead.createdAt],
                ['Primeiro contato', lead.firstContactAt],
                ['Último contato', lead.lastContactAt],
              ].map(([label, date]) => (
                <div key={label as string} className="flex justify-between border-b border-neutral-100 dark:border-neutral-800 pb-2 last:border-0">
                  <span className="text-neutral-500">{label as string}</span>
                  <span className="font-medium">
                    {date ? format(new Date(date as Date), 'dd/MM/yyyy', { locale: ptBR }) : '—'}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
