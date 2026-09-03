import type { NextAuthConfig } from 'next-auth';

// Configuracao compartilhada pelo middleware Edge e pelo servidor Node.
// Nao importar banco, bcrypt ou crypto aqui: este arquivo entra no bundle
// do middleware e precisa permanecer compativel com Edge Runtime.
const authConfig = {
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