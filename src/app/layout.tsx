import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { AppShell } from '@/components/layout/app-shell';
import { getCurrentUser } from '@/lib/auth-helpers';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Sirrus CRM | Prospecting',
  description: 'CRM inteligente de prospecção comercial para Sirrus',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // null na tela de login (sem sessão) — AppShell já esconde a barra
  // lateral nesse caso, então não precisa de tratamento especial aqui.
  const currentUser = await getCurrentUser();

  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body className={`${inter.className} min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-50 flex`}>
        <AppShell currentUser={currentUser}>{children}</AppShell>
      </body>
    </html>
  );
}
