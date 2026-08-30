import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Sidebar } from '@/components/layout/sidebar';
import { WorkerProgress } from '@/components/layout/worker-progress';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Sirrus CRM | Prospecting',
  description: 'CRM inteligente de prospecção comercial para Sirrus',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body className={`${inter.className} min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-50 flex`}>
        <Sidebar />
        <main className="flex-1 flex flex-col h-screen overflow-hidden">
          <WorkerProgress />
          <div className="flex-1 overflow-auto bg-neutral-100/50 dark:bg-neutral-900/50 p-6">
            {children}
          </div>
        </main>
      </body>
    </html>
  );
}
