import type { DefaultSession } from 'next-auth';

// Amplia os tipos do Auth.js pra incluir os campos extras que colocamos na
// sessão/token em src/auth.ts (id e role). Sem isso, session.user.role e
// token.id ficam como `any`/erro de tipo em todo lugar que os usa.
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: string;
    } & DefaultSession['user'];
  }

  interface User {
    role?: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    role?: string;
  }
}
