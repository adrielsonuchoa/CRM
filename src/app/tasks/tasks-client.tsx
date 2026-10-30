'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { AlertTriangle, AtSign, CalendarClock, Check, CheckCircle2, ListTodo, MessageCircle, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cancelTaskAction, completeTaskAction } from './actions';

export type TaskItem = {
  id: string;
  type: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  leadId: string;
  businessName: string;
  pipelineStage: string;
  instagramUsername: string | null;
  whatsAppUrl: string | null;
};

type Group = { key: string; label: string; tone: string; items: TaskItem[] };

function groupTasks(items: TaskItem[]): Group[] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  const overdue: TaskItem[] = [];
  const today: TaskItem[] = [];
  const upcoming: TaskItem[] = [];
  const noDate: TaskItem[] = [];
  for (const task of items) {
    if (!task.dueAt) { noDate.push(task); continue; }
    const due = new Date(task.dueAt);
    if (due < startOfToday) overdue.push(task);
    else if (due < startOfTomorrow) today.push(task);
    else upcoming.push(task);
  }

  return [
    { key: 'overdue', label: 'Atrasadas', tone: 'text-red-600', items: overdue },
    { key: 'today', label: 'Hoje', tone: 'text-blue-600', items: today },
    { key: 'upcoming', label: 'Próximas', tone: 'text-neutral-700 dark:text-neutral-300', items: upcoming },
    { key: 'no-date', label: 'Sem data', tone: 'text-neutral-500', items: noDate },
  ];
}

export function TasksClient({ initialTasks }: { initialTasks: TaskItem[] }) {
  const [items, setItems] = useState(initialTasks);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function close(taskId: string, action: 'complete' | 'cancel') {
    setPendingId(taskId);
    setError(null);
    startTransition(async () => {
      const res = action === 'complete' ? await completeTaskAction(taskId) : await cancelTaskAction(taskId);
      setPendingId(null);
      if (res.success) setItems((current) => current.filter((task) => task.id !== taskId));
      else setError(res.error ?? 'Falha ao atualizar tarefa.');
    });
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-16 flex flex-col items-center gap-3 text-neutral-400">
          <CheckCircle2 className="w-10 h-10 opacity-40" />
          <p>Nenhuma tarefa pendente.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-center gap-3 rounded-lg p-3 text-sm border bg-red-50 text-red-800 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {groupTasks(items).filter((group) => group.items.length > 0).map((group) => (
        <Card key={group.key}>
          <CardHeader>
            <CardTitle className={`flex items-center gap-2 ${group.tone}`}>
              {group.key === 'overdue' ? <AlertTriangle className="w-5 h-5" /> : <CalendarClock className="w-5 h-5" />}
              {group.label}
              <span className="text-sm font-normal text-neutral-500">({group.items.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {group.items.map((task) => (
                <div key={task.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{task.title}</span>
                      <Badge variant={task.type === 'FOLLOW_UP' ? 'secondary' : 'outline'} className="text-[10px]">
                        {task.type === 'FOLLOW_UP' ? 'Follow-up' : 'Tarefa'}
                      </Badge>
                    </div>
                    <p className="text-xs text-neutral-500 mt-1">
                      <Link href={`/leads/${task.leadId}`} className="hover:text-blue-600 hover:underline">{task.businessName}</Link>
                      {' · '}{task.pipelineStage}
                      {task.dueAt && ` · ${format(new Date(task.dueAt), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}`}
                    </p>
                    {task.notes && <p className="text-xs text-neutral-500 mt-1 whitespace-pre-wrap">{task.notes}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    {task.whatsAppUrl && (
                      <a href={task.whatsAppUrl} target="whatsapp-web" title="Abrir conversa no WhatsApp" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                        <MessageCircle className="w-3.5 h-3.5 text-green-600" />
                      </a>
                    )}
                    {task.instagramUsername && (
                      <a href={`https://instagram.com/${task.instagramUsername.replace(/^@/, '')}`} target="_blank" rel="noreferrer" title="Abrir Instagram" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                        <AtSign className="w-3.5 h-3.5" />
                      </a>
                    )}
                    <Button size="sm" onClick={() => close(task.id, 'complete')} disabled={pendingId === task.id}>
                      <Check className="w-3.5 h-3.5 mr-1" />
                      Concluir
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => close(task.id, 'cancel')} disabled={pendingId === task.id} title="Cancelar tarefa">
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}

      <p className="text-xs text-neutral-500 flex items-center gap-1.5">
        <ListTodo className="w-3.5 h-3.5" />
        Ao registrar um envio para o lead, o follow-up pendente é concluído e o próximo é agendado (Configurações → dias e limite de follow-ups).
      </p>
    </div>
  );
}
