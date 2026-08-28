'use client';

import { useState, useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import Link from 'next/link';
import { Search, Store } from 'lucide-react';

type Lead = {
  id: string;
  businessName: string;
  instagramUsername: string | null;
  neighborhood: string | null;
  category: string | null;
  leadScore: number | null;
  pipelineStage: string;
  source: string | null;
  hasDelivery: boolean | null;
  hasDiningRoom: boolean | null;
  doNotContact: boolean | null;
};

export function LeadsTable({ initialLeads }: { initialLeads: Lead[] }) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return initialLeads;
    return initialLeads.filter((l) =>
      l.businessName.toLowerCase().includes(q) ||
      (l.instagramUsername?.toLowerCase().includes(q) ?? false) ||
      (l.neighborhood?.toLowerCase().includes(q) ?? false) ||
      (l.category?.toLowerCase().includes(q) ?? false)
    );
  }, [search, initialLeads]);

  function scoreColor(score: number | null) {
    if (score == null) return '';
    if (score >= 80) return 'text-blue-600 font-bold';
    if (score >= 60) return 'text-green-600';
    return '';
  }

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400 pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome, bairro, categoria..."
          className="pl-9"
        />
      </div>

      {/* Table */}
      <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg bg-white dark:bg-neutral-950 shadow-sm overflow-hidden">
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
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-16 text-neutral-400">
                  <div className="flex flex-col items-center gap-3">
                    <Store className="w-10 h-10 opacity-30" />
                    <p className="text-base">
                      {search ? `Nenhum resultado para "${search}"` : 'Nenhum lead cadastrado.'}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((lead) => (
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
                    <Link
                      href={`/leads/${lead.id}`}
                      className="text-sm font-medium text-blue-600 hover:underline"
                    >
                      Ver Detalhes →
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {filtered.length > 0 && search && (
        <p className="text-xs text-neutral-500">
          {filtered.length} resultado{filtered.length !== 1 ? 's' : ''} para &quot;{search}&quot;
        </p>
      )}
    </div>
  );
}
