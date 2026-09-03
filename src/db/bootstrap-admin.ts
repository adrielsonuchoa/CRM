import { db } from './index';
import { users } from './schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// Cria o primeiro usuário SUPER_ADMIN. Só existe pra isso — depois do
// primeiro admin criado, todo novo usuário é criado por ele mesmo na tela
// de Usuários (Configurações → Usuários), nunca por este script. Não há
// tela pública de cadastro no sistema.
//
// Regras (pedidas explicitamente):
//   - Sem credenciais padrão (nada de admin/admin, 123456, password, etc.)
//   - Tudo vem de variáveis de ambiente — nunca hardcoded aqui
//   - Idempotente: pode rodar várias vezes sem duplicar nem sobrescrever
//     a senha de um admin que já existe
//   - Nunca imprime a senha no console, mesmo a que veio do .env
//
// Uso:
//   1. Defina no .env.local (NUNCA no .env.example / commitado):
//        SUPER_ADMIN_NAME="Seu Nome"
//        SUPER_ADMIN_EMAIL="voce@exemplo.com"
//        SUPER_ADMIN_PASSWORD="uma senha forte, 12+ caracteres"
//   2. Rode: npm run db:bootstrap-admin

const WEAK_PASSWORDS = new Set([
  '123456',
  '12345678',
  '123456789',
  'password',
  'senha123',
  'admin',
  'admin123',
  'qwerty',
  '11111111',
  '00000000',
  'letmein',
  'change-me',
  'changeme',
]);

function fail(message: string): never {
  console.error(`\n[bootstrap-admin] ERRO: ${message}\n`);
  process.exit(1);
}

async function bootstrap() {
  const name = process.env.SUPER_ADMIN_NAME?.trim();
  const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD;

  if (!name || !email || !password) {
    fail(
      'Defina SUPER_ADMIN_NAME, SUPER_ADMIN_EMAIL e SUPER_ADMIN_PASSWORD no .env.local antes de rodar este script. ' +
        'Nenhum usuário é criado com valores padrão.',
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail(`SUPER_ADMIN_EMAIL ("${email}") não parece um e-mail válido.`);
  }

  if (password.length < 12) {
    fail('SUPER_ADMIN_PASSWORD precisa ter pelo menos 12 caracteres.');
  }

  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    fail('SUPER_ADMIN_PASSWORD é uma senha comum/fraca demais. Escolha outra.');
  }

  const existing = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];

  if (existing) {
    console.log(
      `[bootstrap-admin] Já existe um usuário com o e-mail "${email}" (role: ${existing.role}, status: ${existing.status}). ` +
        'Nada foi alterado — este script nunca sobrescreve um usuário existente. ' +
        'Para redefinir a senha de um admin existente, use a tela de Usuários (logado como outro SUPER_ADMIN) ou rode um script de reset dedicado.',
    );
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date();

  await db.insert(users).values({
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash,
    role: 'SUPER_ADMIN',
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  });

  console.log(`\n[bootstrap-admin] Usuário SUPER_ADMIN criado com sucesso: ${name} <${email}>.`);
  console.log('[bootstrap-admin] Faça login em /login com o e-mail e a senha definidos no .env.local.\n');
  process.exit(0);
}

bootstrap().catch((err) => {
  console.error('[bootstrap-admin] Falha ao criar o usuário:', err);
  process.exit(1);
});
