'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { LayoutDashboard, Users, Kanban, ClipboardList, Settings, Store, ScrollText, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import type { CurrentUser } from '@/lib/auth-helpers';
import type { PermissionKey } from '@/lib/permissions';

// Só os campos que a barra lateral precisa — importado por tipo do
// auth-helpers (apagado em tempo de compilação, não puxa nada server-only
// pro bundle do cliente).
export type SidebarUser = Pick<CurrentUser, 'id' | 'name' | 'email' | 'role' | 'permissions'>;

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Administrador',
  VENDEDOR: 'Vendedor',
};

const navItems = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Fila de Prospecção', href: '/prospecting', icon: ClipboardList },
  { name: 'Pipeline', href: '/pipeline', icon: Kanban },
  { name: 'Leads', href: '/leads', icon: Users },
  { name: 'Configurações', href: '/settings', icon: Settings },
];

function hasPermission(user: SidebarUser | null, key: PermissionKey) {
  if (!user) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  return user.permissions.includes(key);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + last).toUpperCase() || '?';
}

export function Sidebar({ currentUser }: { currentUser: SidebarUser | null }) {
  const pathname = usePathname();
  const router = useRouter();

  const extraItems = [
    hasPermission(currentUser, 'USERS_VIEW') && { name: 'Usuários', href: '/settings/users', icon: Users },
    hasPermission(currentUser, 'AUDIT_LOG_VIEW') && { name: 'Logs de Auditoria', href: '/settings/audit-log', icon: ScrollText },
  ].filter(Boolean) as { name: string; href: string; icon: typeof Users }[];

  async function handleLogout() {
    await signOut({ redirect: false });
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="w-64 h-full bg-white dark:bg-neutral-950 border-r border-neutral-200 dark:border-neutral-800 flex flex-col">
      <div className="p-6 border-b border-neutral-200 dark:border-neutral-800 flex items-center gap-3">
        <div className="bg-blue-600 p-2 rounded-lg">
          <Store className="w-6 h-6 text-white" />
        </div>
        <div className="flex flex-col">
          <span className="font-bold text-lg leading-none tracking-tight">Sirrus CRM</span>
          <span className="text-xs text-neutral-500 mt-1">Maceió / AL</span>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        {[...navItems, ...extraItems].map((item) => {
          const isActive = pathname === item.href || (pathname.startsWith(item.href) && item.href !== '/');

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-md transition-all text-sm font-medium",
                isActive
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400"
                  : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900 hover:text-neutral-900 dark:hover:text-neutral-50"
              )}
            >
              <item.icon className="w-5 h-5" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback className="bg-neutral-200 text-neutral-600">
              {currentUser ? initials(currentUser.name) : '—'}
            </AvatarFallback>
          </Avatar>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-sm font-medium truncate">{currentUser?.name ?? 'Não autenticado'}</span>
            <span className="text-xs text-neutral-500">{currentUser ? (ROLE_LABELS[currentUser.role] ?? currentUser.role) : ''}</span>
          </div>
          {currentUser && (
            <button
              onClick={handleLogout}
              title="Sair"
              aria-label="Sair"
              className="text-neutral-400 hover:text-red-600 p-1.5 rounded-md hover:bg-red-50 dark:hover:bg-red-950/30 shrink-0"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
