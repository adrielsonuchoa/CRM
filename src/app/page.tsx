import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { db } from '@/db';
import { leads, demos, tasks, activities } from '@/db/schema';
import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { Store, MessagesSquare, CheckCircle2, TrendingUp, CalendarCheck, Users, AlertTriangle, ListTodo, Send } from 'lucide-react';
import { TASK_STATUS } from '@/lib/follow-ups';
import Link from 'next/link';
import { getRecentWorkerActivities, getWorkerStatus } from '@/lib/browser-worker';
import { DashboardWorkerStatus } from './dashboard-worker-status';

export const metadata = {
  title: 'Dashboard | Sirrus CRM',
};

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const startOfToday = new Date(new Date().setHours(0, 0, 0, 0));
  const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);

  // Disparado antes das consultas principais e aguardado depois: roda em
  // paralelo com elas em vez de somar mais uma ida ao banco.
  const followUpStatsPromise = Promise.all([
    db.select({ count: count() }).from(tasks).where(and(eq(tasks.status, TASK_STATUS.PENDING), lt(tasks.dueAt, startOfToday))),
    db.select({ count: count() }).from(tasks).where(and(eq(tasks.status, TASK_STATUS.PENDING), gte(tasks.dueAt, startOfToday), lt(tasks.dueAt, startOfTomorrow))),
    db.select({ channel: activities.channel, count: count() })
      .from(activities)
      .where(and(eq(activities.type, 'MESSAGE_SENT'), gte(activities.createdAt, sevenDaysAgo)))
      .groupBy(activities.channel),
  ]);

  const [
    totalResult,
    qualifiedResult,
    contactedResult,
    respondedResult,
    interestedResult,
    clientResult,
    demosResult,
    foundTodayResult,
    workerStatus,
    workerLogs,
    recentLeads,
  ] = await Promise.all([
    db.select({ count: count() }).from(leads),
    db.select({ count: count() }).from(leads).where(
      sql`${leads.pipelineStage} IN ('QUALIFICADO', 'PRONTO PARA CONTATO', 'CONTATO REALIZADO', 'RESPONDEU', 'CONVERSANDO', 'INTERESSADO', 'WHATSAPP', 'DEMONSTRAÇÃO AGENDADA', 'DEMONSTRAÇÃO REALIZADA', 'PROPOSTA', 'NEGOCIAÇÃO', 'CLIENTE')`
    ),
    db.select({ count: count() }).from(leads).where(
      sql`${leads.pipelineStage} IN ('CONTATO REALIZADO', 'RESPONDEU', 'CONVERSANDO', 'INTERESSADO', 'WHATSAPP', 'DEMONSTRAÇÃO AGENDADA', 'DEMONSTRAÇÃO REALIZADA', 'PROPOSTA', 'NEGOCIAÇÃO', 'CLIENTE')`
    ),
    db.select({ count: count() }).from(leads).where(
      sql`${leads.pipelineStage} IN ('RESPONDEU', 'CONVERSANDO', 'INTERESSADO', 'WHATSAPP', 'DEMONSTRAÇÃO AGENDADA', 'DEMONSTRAÇÃO REALIZADA', 'PROPOSTA', 'NEGOCIAÇÃO', 'CLIENTE')`
    ),
    db.select({ count: count() }).from(leads).where(
      sql`${leads.pipelineStage} IN ('INTERESSADO', 'WHATSAPP', 'DEMONSTRAÇÃO AGENDADA', 'DEMONSTRAÇÃO REALIZADA', 'PROPOSTA', 'NEGOCIAÇÃO', 'CLIENTE')`
    ),
    db.select({ count: count() }).from(leads).where(sql`${leads.pipelineStage} = 'CLIENTE'`),
    db.select({ count: count() }).from(demos),
    db.select({ count: count() }).from(leads).where(sql`${leads.createdAt} >= ${new Date(new Date().setHours(0, 0, 0, 0))}`),
    getWorkerStatus(),
    getRecentWorkerActivities(),
    db.select({
      id: leads.id,
      businessName: leads.businessName,
      instagramUsername: leads.instagramUsername,
      phone: leads.phone,
      neighborhood: leads.neighborhood,
      category: leads.category,
      rating: leads.rating,
      reviewCount: leads.reviewCount,
      followers: leads.followers,
      leadScore: leads.leadScore,
      pipelineStage: leads.pipelineStage,
      source: leads.source,
    }).from(leads).orderBy(desc(leads.createdAt)).limit(10),
  ]);

  const [overdueTasksResult, todayTasksResult, sentByChannel] = await followUpStatsPromise;
  const overdueTasks = overdueTasksResult[0].count;
  const todayTasks = todayTasksResult[0].count;
  const sentLast7Days = sentByChannel.reduce((sum, row) => sum + row.count, 0);
  const sentByChannelLabel = sentByChannel
    .map((row) => `${row.channel ?? 'OUTRO'}: ${row.count}`)
    .join(' · ');

  const total = totalResult[0].count;
  const qualified = qualifiedResult[0].count;
  const contacted = contactedResult[0].count;
  const responded = respondedResult[0].count;
  const interested = interestedResult[0].count;
  const clients = clientResult[0].count;
  const demosCount = demosResult[0].count;
  const foundToday = foundTodayResult[0].count;

  const responseRate = contacted > 0 ? ((responded / contacted) * 100).toFixed(1) : '—';

  const funnelSteps = [
    { label: 'Encontrados', value: total, color: 'bg-neutral-400', href: '/leads' },
    { label: 'Qualificados', value: qualified, color: 'bg-blue-400', href: '/leads' },
    { label: 'Abordados', value: contacted, color: 'bg-blue-500', href: '/pipeline' },
    { label: 'Responderam', value: responded, color: 'bg-indigo-500', href: '/pipeline' },
    { label: 'Interessados', value: interested, color: 'bg-violet-600', href: '/pipeline' },
    { label: 'Clientes', value: clients, color: 'bg-green-600', href: '/pipeline' },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-neutral-500">Resumo da prospecção comercial em Maceió / AL</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { label: 'Hoje', value: foundToday, icon: Store, color: 'text-neutral-500', href: '/leads' },
          { label: 'Qualificados', value: qualified, icon: CheckCircle2, color: 'text-blue-500', href: '/leads' },
          { label: 'Abordados', value: contacted, icon: MessagesSquare, color: 'text-blue-600', href: '/pipeline' },
          { label: 'Responderam', value: responded, icon: Users, color: 'text-indigo-600', href: '/pipeline' },
          { label: 'Interessados', value: interested, icon: TrendingUp, color: 'text-violet-600', href: '/pipeline' },
          { label: 'Demos', value: demosCount, icon: CalendarCheck, color: 'text-green-600', href: '/pipeline' },
        ].map(({ label, value, icon: Icon, color, href }) => (
          <Link key={label} href={href}>
            <Card className="hover:border-blue-300 transition-colors cursor-pointer">
              <CardHeader className="flex flex-row items-center justify-between pb-1 pt-3 px-4">
                <CardTitle className="text-xs font-medium text-neutral-500">{label}</CardTitle>
                <Icon className={`w-4 h-4 ${color}`} />
              </CardHeader>
              <CardContent className="pb-3 px-4">
                <div className="text-2xl font-bold">{value}</div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* Acompanhamento */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/tasks">
          <Card className={`hover:border-blue-300 transition-colors cursor-pointer ${overdueTasks > 0 ? 'border-red-200 dark:border-red-900' : ''}`}>
            <CardHeader className="flex flex-row items-center justify-between pb-1 pt-3 px-4">
              <CardTitle className="text-xs font-medium text-neutral-500">Follow-ups atrasados</CardTitle>
              <AlertTriangle className={`w-4 h-4 ${overdueTasks > 0 ? 'text-red-600' : 'text-neutral-400'}`} />
            </CardHeader>
            <CardContent className="pb-3 px-4">
              <div className={`text-2xl font-bold ${overdueTasks > 0 ? 'text-red-600' : ''}`}>{overdueTasks}</div>
            </CardContent>
          </Card>
        </Link>
        <Link href="/tasks">
          <Card className="hover:border-blue-300 transition-colors cursor-pointer">
            <CardHeader className="flex flex-row items-center justify-between pb-1 pt-3 px-4">
              <CardTitle className="text-xs font-medium text-neutral-500">Tarefas para hoje</CardTitle>
              <ListTodo className="w-4 h-4 text-blue-600" />
            </CardHeader>
            <CardContent className="pb-3 px-4">
              <div className="text-2xl font-bold">{todayTasks}</div>
            </CardContent>
          </Card>
        </Link>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-neutral-500">Mensagens enviadas (7 dias)</CardTitle>
            <Send className="w-4 h-4 text-indigo-600" />
          </CardHeader>
          <CardContent className="pb-3 px-4">
            <div className="text-2xl font-bold">{sentLast7Days}</div>
            {sentByChannelLabel && <p className="text-xs text-neutral-500 mt-1">{sentByChannelLabel}</p>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Leads recentes</CardTitle>
            <CardDescription>Últimos registros inseridos no CRM</CardDescription>
          </div>
          <Link href="/leads" className="text-sm font-medium text-blue-600 hover:underline">
            Ver todos
          </Link>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {recentLeads.map((lead) => (
              <Link
                key={lead.id}
                href={`/leads/${lead.id}`}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0 hover:text-blue-600"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{lead.businessName}</p>
                  <p className="text-xs text-neutral-500">
                    {lead.instagramUsername ? `@${lead.instagramUsername.replace(/^@/, '')}` : 'Instagram pendente'}
                    {lead.category ? ` · ${lead.category}` : ''}
                  </p>
                  <p className="mt-1 text-xs text-neutral-500">
                    {[lead.neighborhood, lead.phone, lead.rating != null ? `★ ${lead.rating}${lead.reviewCount != null ? ` (${lead.reviewCount})` : ''}` : null, lead.followers != null ? `${lead.followers.toLocaleString('pt-BR')} seguidores` : null].filter(Boolean).join(' · ') || 'Dados de contato pendentes'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {lead.leadScore != null && <span className="text-xs font-semibold text-blue-600">Score {lead.leadScore}</span>}
                  <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                    {lead.pipelineStage}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Funnel */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Funil de Prospecção</CardTitle>
            <CardDescription>Conversão por etapa do pipeline</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {funnelSteps.map(({ label, value, color, href }) => {
                const pct = total > 0 ? Math.round((value / total) * 100) : 0;
                return (
                  <Link key={label} href={href} className="block group">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-sm font-medium group-hover:text-blue-600 transition-colors">{label}</span>
                      <span className="text-sm text-neutral-500">{value} <span className="text-neutral-400">({pct}%)</span></span>
                    </div>
                    <div className="h-2 bg-neutral-100 dark:bg-neutral-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${color} rounded-full transition-all`}
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                    </div>
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Rate card */}
        <Card>
          <CardHeader>
            <CardTitle>Taxa de Resposta</CardTitle>
            <CardDescription>Leads abordados que responderam</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="text-center">
              <div className="text-5xl font-black text-blue-600">{responseRate}%</div>
              <p className="text-sm text-neutral-500 mt-2">{responded} de {contacted} responderam</p>
            </div>

            <div className="space-y-2 text-sm border-t pt-4">
              <div className="flex justify-between">
                <span className="text-neutral-500">Total leads</span>
                <span className="font-medium">{total}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Clientes</span>
                <span className="font-medium text-green-600">{clients}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-500">Taxa conversão</span>
                <span className="font-medium text-green-600">
                  {total > 0 ? ((clients / total) * 100).toFixed(1) : '—'}%
                </span>
              </div>
            </div>

            <Link href="/prospecting" className="block">
              <div className="bg-blue-600 hover:bg-blue-700 text-white text-center rounded-lg py-2 text-sm font-medium transition-colors">
                Abrir Fila de Prospecção →
              </div>
            </Link>
          </CardContent>
        </Card>
      </div>

      <DashboardWorkerStatus initialStatus={workerStatus} initialLogs={workerLogs} />
    </div>
  );
}
