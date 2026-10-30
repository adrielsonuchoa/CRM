import type { NextAuthConfig } from 'next-auth';

// Configuracao compartilhada pelo middleware Edge e pelo servidor Node.
// Nao importar banco, bcrypt ou crypto aqui: este arquivo entra no bundle
// do middleware e precisa permanecer compativel com Edge Runtime.
const authConfig = {
  // O app roda 100% local (localhost, sem exposicao publica/proxy externo)
  // no PC do cliente - sem isso, o Auth.js v5 rejeita o proprio localhost
  // como "UntrustedHost" fora do modo dev (ex.: no server.js do build
  // standalone), e o login nunca funciona.
  trustHost: true,
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/login',
  },
  callbacks: {
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
  providers: [],
} satisfies NextAuthConfig;

export default authConfig;