import type { Metadata } from 'next';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Entrar | Sirrus CRM',
};

// Sem cadastro público aqui de propósito: só o SUPER_ADMIN cria usuários,
// pela tela de Configurações → Usuários.
export default function LoginPage() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-neutral-100/50 dark:bg-neutral-900/50 p-6">
      <LoginForm />
    </div>
  );
}
