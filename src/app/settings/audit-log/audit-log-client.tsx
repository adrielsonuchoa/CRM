'use client';

import { useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollText, Search } from 'lucide-react';

type AuditLogRow = {
  id: string;
  userId: string | null;
  userName: string | null;
  action: string;
  category: string;
  entityType: string | null;
  entityId: string | null;
  description: string;
  metadata: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
};

const CATEGORIES = ['AUTH', 'USERS', 'LEADS', 'PIPELINE', 'MESSAGES', 'AUTOMATION', 'SETTINGS'] as const;

const CATEGORY_LABELS: Record<string, string> = {
  AUTH: 'Autenticação',
  USERS: 'Usuários',
  LEADS: 'Leads',
  PIPELINE: 'Pipeline',
  MESSAGES: 'Mensagens',
  AUTOMATION: 'Automação',
  SETTINGS: 'Configurações',
};

const PAGE_SIZE = 25;

export function AuditLogClient({ initialLogs }: { initialLogs: AuditLogRow[] }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>('ALL');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<AuditLogRow | null>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return initialLogs.filter((log) => {
      if (category !== 'ALL' && log.category !== category) return false;
      if (!q) return true;
      return (
        log.action.toLowerCase().includes(q) ||
        log.description.toLowerCase().includes(q) ||
        (log.userName?.toLowerCase().includes(q) ?? false) ||
        (log.entityId?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [search, category, initialLogs]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  function handleSearchChange(value: string) {
    setSearch(value);
    setPage(0);
  }

  function handleCategoryChange(value: string) {
    setCategory(value);
    setPage(0);
  }

  let prettyMetadata: string | null = null;
  if (selected?.metadata) {
    try {
      prettyMetadata = JSON.stringify(JSON.parse(selected.metadata), null, 2);
    } catch {
      prettyMetadata = selected.metadata;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1 min-w-52">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Buscar por ação, descrição, usuário..."
            className="pl-9"
          />
        </div>
        <select
          value={category}
          onChange={(e) => handleCategoryChange(e.target.value)}
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
        >
          <option value="ALL">Todas as categorias</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
          ))}
        </select>
      </div>

      <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg bg-white dark:bg-neutral-950 shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-neutral-50 dark:bg-neutral-900/50">
            <TableRow>
              <TableHead>Quando</TableHead>
              <TableHead>Quem</TableHead>
              <TableHead>Categoria</TableHead>
              <TableHead>Ação</TableHead>
              <TableHead>Descrição</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-16 text-neutral-400">
                  <div className="flex flex-col items-center gap-3">
                    <ScrollText className="w-10 h-10 opacity-30" />
                    <p className="text-base">Nenhum registro encontrado.</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((log) => (
                <TableRow key={log.id} className="cursor-pointer" onClick={() => setSelected(log)}>
                  <TableCell className="text-xs text-neutral-500 whitespace-nowrap">
                    {new Date(log.createdAt).toLocaleString('pt-BR')}
                  </TableCell>
                  <TableCell className="text-sm">{log.userName ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">{CATEGORY_LABELS[log.category] ?? log.category}</Badge>
                  </TableCell>
                  <TableCell className="text-xs font-mono text-neutral-500">{log.action}</TableCell>
                  <TableCell className="text-sm max-w-md truncate">{log.description}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {filtered.length > 0 && (
        <div className="flex items-center justify-between text-sm text-neutral-500">
          <span>
            {filtered.length} registro{filtered.length !== 1 ? 's' : ''} — página {currentPage + 1} de {totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              Anterior
            </Button>
            <Button variant="outline" size="sm" disabled={currentPage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
              Próxima
            </Button>
          </div>
        </div>
      )}

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>{selected.action}</DialogTitle>
                <DialogDescription>{new Date(selected.createdAt).toLocaleString('pt-BR')}</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Descrição</p>
                  <p>{selected.description}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Usuário</p>
                    <p>{selected.userName ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Categoria</p>
                    <p>{CATEGORY_LABELS[selected.category] ?? selected.category}</p>
                  </div>
                  {selected.entityType && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Entidade</p>
                      <p>{selected.entityType} {selected.entityId ? `(${selected.entityId})` : ''}</p>
                    </div>
                  )}
                  {selected.ipAddress && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">IP</p>
                      <p className="font-mono text-xs">{selected.ipAddress}</p>
                    </div>
                  )}
                </div>
                {selected.userAgent && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Navegador</p>
                    <p className="text-xs break-all text-neutral-500">{selected.userAgent}</p>
                  </div>
                )}
                {prettyMetadata && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">Detalhes</p>
                    <pre className="bg-neutral-100 dark:bg-neutral-900 rounded-md p-2 text-xs overflow-x-auto">{prettyMetadata}</pre>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
