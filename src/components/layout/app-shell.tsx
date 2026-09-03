'use client';

import { usePathname } from 'next/navigation';
import { Sidebar, type SidebarUser } from '@/components/layout/sidebar';
import { WorkerProgress } from '@/components/layout/worker-progress';

// Rotas que não devem ter a barra lateral nem o indicador de progresso do
// worker — hoje só a tela de login, que roda antes de existir sessão.
const CHROME_LESS_PATHS = ['/login'];

function isChromeLessPath(pathname: string) {
  return CHROME_LESS_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export function AppShell({ children, currentUser }: { children: React.ReactNode; currentUser: SidebarUser | null }) {
  const pathname = usePathname();

  if (isChromeLessPath(pathname)) {
    return <main className="flex-1 flex flex-col h-screen overflow-auto">{children}</main>;
  }

  return (
    <>
      <Sidebar currentUser={currentUser} />
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <WorkerProgress />
        <div className="flex-1 overflow-auto bg-neutral-100/50 dark:bg-neutral-900/50 p-6">
          {children}
        </div>
      </main>
    </>
  );
}
