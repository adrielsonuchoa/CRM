import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { logAudit } from '@/lib/audit-log';

// Best-effort só — atrás de proxies (Vercel, etc.) o IP real vem em
// x-forwarded-for; sem isso, seguimos sem IP em vez de travar o login.
function extractRequestMeta(request: Request | undefined) {
  const headers = request?.headers;
  const forwardedFor = headers?.get('x-forwarded-for');
  const ipAddress = forwardedFor ? forwardedFor.split(',')[0]?.trim() ?? null : null;
  const userAgent = headers?.get('user-agent') ?? null;
  return { ipAddress, userAgent };
}

async function safeLogAudit(input: Parameters<typeof logAudit>[0]) {
  // Um erro no log de auditoria nunca pode travar login/logout do usuário.
  try {
    await logAudit(input);
  } catch (err) {
    console.error('[auth] falha ao gravar audit log:', err);
  }
}

// AUTH_SECRET ausente é justamente um dos gatilhos conhecidos de uma falha
// grave do Auth.js v5 (GHSA-8fpg-xm3f-6cx3, corrigida na beta.32): quando a
// configuração está quebrada, o objeto de sessão pode virar um objeto de erro
// truthy em vez de null, fazendo checagens do tipo `if (session)` liberarem
// acesso pra qualquer requisição. Por isso validamos aqui, cedo, com um erro
// claro no boot em vez de deixar o app subir "autenticando" tudo por engano.
if (!process.env.AUTH_SECRET) {
  throw new Error(
    'AUTH_SECRET não configurada. Gere uma com `npx auth secret` e adicione ao .env.local antes de rodar o app.',
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/login',
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: 'E-mail', type: 'email' },
        password: { label: 'Senha', type: 'password' },
      },
      authorize: async (credentials, request) => {
        const { ipAddress, userAgent } = extractRequestMeta(request);
        const email = typeof credentials?.email === 'string' ? credentials.email.trim().toLowerCase() : '';
        const password = typeof credentials?.password === 'string' ? credentials.password : '';

        // Nunca logamos a senha em si — só o e-mail tentado, pra dar rastro
        // de tentativas de login sem expor segredo nenhum.
        const logFailure = (reason: string) =>
          safeLogAudit({
            userId: null,
            userName: null,
            action: 'AUTH_LOGIN_FAILED',
            category: 'AUTH',
            description: `Tentativa de login falhou (${reason}) para "${email || '(vazio)'}".`,
            ipAddress,
            userAgent,
          });

        if (!email || !password) {
          await logFailure('credenciais ausentes');
          return null;
        }

        const record = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
        if (!record) {
          await logFailure('usuário não encontrado');
          return null;
        }
        if (record.status !== 'ACTIVE') {
          await logFailure('usuário inativo');
          return null;
        }

        const passwordMatches = await bcrypt.compare(password, record.passwordHash);
        if (!passwordMatches) {
          await logFailure('senha incorreta');
          return null;
        }

        await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, record.id));

        await safeLogAudit({
          userId: record.id,
          userName: record.name,
          action: 'AUTH_LOGIN',
          category: 'AUTH',
          description: `${record.name} entrou no sistema.`,
          ipAddress,
          userAgent,
        });

        return {
          id: record.id,
          name: record.name,
          email: record.email,
          role: record.role,
        };
      },
    }),
  ],
  callbacks: {
    // Guardamos só o essencial no token (id/role). Permissões finas NÃO
    // ficam aqui: elas são lidas do banco a cada ação sensível (ver
    // src/lib/auth-helpers.ts), pra uma revogação de permissão ou uma
    // desativação de usuário feita pelo admin valer imediatamente, e não só
    // depois que o token expirar ou o usuário logar de novo.
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role ?? 'VENDEDOR';
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = String(token.id);
        session.user.role = String(token.role ?? 'VENDEDOR');
      }
      return session;
    },
  },
});
