'use client';

import { useState, useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button, buttonVariants } from '@/components/ui/button';
import { buildWhatsAppUrl, normalizeWhatsAppNumber } from '@/lib/phone';
import { toCsv } from '@/lib/csv';
import Link from 'next/link';
import { Search, Store, MessageCircle, Download, ChevronLeft, ChevronRight, X } from 'lucide-react';

type Lead = {
  id: string;
  businessName: string;
  instagramUsername: string | null;
  neighborhood: string | null;
  city: string | null;
  category: string | null;
  leadScore: number | null;
  pipelineStage: string;
  source: string | null;
  hasDelivery: boolean | null;
  hasDiningRoom: boolean | null;
  doNotContact: boolean | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  website: string | null;
  createdAt: Date;
  lastGeneratedMessage: string | null;
};

const PAGE_SIZE = 25;
const ALL = '';

const selectClassName = 'h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

function distinct(values: (string | null)[]) {
  return Array.from(new Set(values.filter((value): value is string => !!value))).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function exportLeadsCsv(rows: Lead[]) {
  // Mesmos nomes de coluna que o importador de CSV (Configurações) aceita,
  // pra o arquivo exportado poder ser reimportado em outra instalação.
  const headers = ['nome', 'instagram', 'telefone', 'whatsapp', 'email', 'website', 'bairro', 'cidade', 'segmento', 'score', 'fase', 'fonte', 'nao_contatar', 'criado_em'];
  const csv = toCsv(headers, rows.map((lead) => [
    lead.businessName,
    lead.instagramUsername ? `@${lead.instagramUsername.replace(/^@/, '')}` : '',
    lead.phone,
    lead.whatsapp,
    lead.email,
    lead.website,
    lead.neighborhood,
    lead.city,
    lead.category,
    lead.leadScore,
    lead.pipelineStage,
    lead.source,
    lead.doNotContact ? 'sim' : 'nao',
    new Date(lead.createdAt).toISOString().slice(0, 10),
  ]));

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function LeadsTable({ initialLeads }: { initialLeads: Lead[] }) {
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState(ALL);
  const [source, setSource] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [minScore, setMinScore] = useState('');
  const [onlyWhatsApp, setOnlyWhatsApp] = useState(false);
  const [hideDoNotContact, setHideDoNotContact] = useState(false);
  const [page, setPage] = useState(0);

  const stages = useMemo(() => distinct(initialLeads.map((l) => l.pipelineStage)), [initialLeads]);
  const sources = useMemo(() => distinct(initialLeads.map((l) => l.source)), [initialLeads]);
  const categories = useMemo(() => distinct(initialLeads.map((l) => l.category)), [initialLeads]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const scoreFloor = minScore === '' ? null : Number(minScore);
    return initialLeads.filter((l) => {
      if (q && !(
        l.businessName.toLowerCase().includes(q) ||
        (l.instagramUsername?.toLowerCase().includes(q) ?? false) ||
        (l.neighborhood?.toLowerCase().includes(q) ?? false) ||
        (l.category?.toLowerCase().includes(q) ?? false) ||
        (l.phone?.includes(q) ?? false)
      )) return false;
      if (stage && l.pipelineStage !== stage) return false;
      if (source && l.source !== source) return false;
      if (category && l.category !== category) return false;
      if (scoreFloor !== null && !Number.isNaN(scoreFloor) && (l.leadScore ?? -1) < scoreFloor) return false;
      if (onlyWhatsApp && !normalizeWhatsAppNumber(l.whatsapp ?? l.phone)) return false;
      if (hideDoNotContact && l.doNotContact) return false;
      return true;
    });
  }, [search, stage, source, category, minScore, onlyWhatsApp, hideDoNotContact, initialLeads]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const hasFilters = !!(search || stage || source || category || minScore || onlyWhatsApp || hideDoNotContact);

  // Qualquer mudança de filtro volta pra primeira página.
  function withReset<T>(setter: (value: T) => void) {
    return (value: T) => { setter(value); setPage(0); };
  }

  function clearFilters() {
    setSearch(''); setStage(ALL); setSource(ALL); setCategory(ALL); setMinScore('');
    setOnlyWhatsApp(false); setHideDoNotContact(false); setPage(0);
  }

  function scoreColor(score: number | null) {
    if (score == null) return '';
    if (score >= 80) return 'text-blue-600 font-bold';
    if (score >= 60) return 'text-green-600';
    return '';
  }

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => withReset(setSearch)(e.target.value)}
            placeholder="Buscar por nome, bairro, categoria, telefone..."
            className="pl-9"
          />
        </div>
        <select aria-label="Fase" value={stage} onChange={(e) => withReset(setStage)(e.target.value)} className={selectClassName}>
          <option value={ALL}>Todas as fases</option>
          {stages.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select aria-label="Fonte" value={source} onChange={(e) => withReset(setSource)(e.target.value)} className={selectClassName}>
          <option value={ALL}>Todas as fontes</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select aria-label="Categoria" value={category} onChange={(e) => withReset(setCategory)(e.target.value)} className={selectClassName}>
          <option value={ALL}>Todas as categorias</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <Input
          type="number"
          min={0}
          max={100}
          value={minScore}
          onChange={(e) => withReset(setMinScore)(e.target.value)}
          placeholder="Score mín."
          aria-label="Score mínimo"
          className="w-28"
        />
        <label className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          <input type="checkbox" checked={onlyWhatsApp} onChange={(e) => withReset(setOnlyWhatsApp)(e.target.checked)} />
          Com WhatsApp
        </label>
        <label className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          <input type="checkbox" checked={hideDoNotContact} onChange={(e) => withReset(setHideDoNotContact)(e.target.checked)} />
          Ocultar &quot;Não Contatar&quot;
        </label>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="w-3.5 h-3.5 mr-1" />
            Limpar
          </Button>
        )}
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => exportLeadsCsv(filtered)} disabled={filtered.length === 0}>
          <Download className="w-3.5 h-3.5 mr-1" />
          Exportar CSV ({filtered.length})
        </Button>
      </div>

      {/* Table */}
      <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg bg-white dark:bg-neutral-950 shadow-sm overflow-x-auto">
        <Table>
          <TableHeader className="bg-neutral-50 dark:bg-neutral-900/50">
            <TableRow>
              <TableHead>Estabelecimento</TableHead>
              <TableHead>Bairro</TableHead>
              <TableHead>Categoria</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>Fase</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-16 text-neutral-400">
                  <div className="flex flex-col items-center gap-3">
                    <Store className="w-10 h-10 opacity-30" />
                    <p className="text-base">
                      {hasFilters ? 'Nenhum lead com esses filtros.' : 'Nenhum lead cadastrado.'}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((lead) => (
                <TableRow key={lead.id} className={lead.doNotContact ? 'opacity-50' : ''}>
                  <TableCell className="font-medium">
                    <div>{lead.businessName}</div>
                    {lead.instagramUsername && (
                      <div className="text-xs text-neutral-500">@{lead.instagramUsername.replace(/^@/, '')}</div>
                    )}
                    {lead.doNotContact && (
                      <Badge variant="destructive" className="text-[10px] mt-1">Não Contatar</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-neutral-600 dark:text-neutral-400">
                    {lead.neighborhood ?? '—'}
                  </TableCell>
                  <TableCell>
                    {lead.category ? (
                      <Badge variant="outline" className="text-xs">{lead.category}</Badge>
                    ) : '—'}
                  </TableCell>
                  <TableCell>
                    <span className={scoreColor(lead.leadScore)}>
                      {lead.leadScore ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs whitespace-nowrap">{lead.pipelineStage}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-3">
                      {(() => {
                        const waUrl = buildWhatsAppUrl(lead.whatsapp ?? lead.phone, lead.lastGeneratedMessage);
                        return waUrl ? (
                          <a
                            href={waUrl}
                            target="whatsapp-web"
                            onClick={(e) => e.stopPropagation()}
                            title="Abrir conversa no WhatsApp"
                            className={buttonVariants({ variant: 'outline', size: 'sm' })}
                          >
                            <MessageCircle className="w-3.5 h-3.5 mr-1 text-green-600" />
                            WhatsApp
                          </a>
                        ) : (
                          <Button variant="outline" size="sm" disabled title="Sem telefone válido para WhatsApp">
                            <MessageCircle className="w-3.5 h-3.5 mr-1 opacity-40" />
                            WhatsApp
                          </Button>
                        );
                      })()}
                      <Link
                        href={`/leads/${lead.id}`}
                        className="text-sm font-medium text-blue-600 hover:underline"
                      >
                        Ver Detalhes →
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-neutral-500">
          <span>
            {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} de {filtered.length}
            {hasFilters && ` (filtrado de ${initialLeads.length})`}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0} aria-label="Página anterior">
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <span>Página {currentPage + 1} de {pageCount}</span>
              <Button variant="outline" size="sm" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount - 1} aria-label="Próxima página">
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
