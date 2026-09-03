import NextAuth from 'next-auth';
import authConfig from './auth.config';
import { NextResponse } from 'next/server';

// Rotas que não exigem sessão: a própria tela de login, os endpoints do
// Auth.js, os webhooks do Meta/Instagram (autenticados por assinatura HMAC
// própria, não por sessão de usuário — ver app/api/webhooks/instagram), e o
// health check (não expõe segredo nenhum, só booleans de "está configurado
// ou não" — usado por monitoramento externo, que não tem sessão).
const PUBLIC_PATHS = ['/login', '/api/auth', '/api/webhooks', '/api/health'];

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname, search } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Checagem importante: usar `req.auth?.user?.id` (um campo concreto), não
  // `!!req.auth`. Uma falha de configuração conhecida do Auth.js v5 (corrigida
  // na 5.0.0-beta.32 — GHSA-8fpg-xm3f-6cx3) podia deixar `req.auth` como um
  // objeto de erro truthy quando algo como AUTH_SECRET estava ausente,
  // fazendo `if (req.auth)` liberar acesso pra todo mundo por engano.
  const isAuthenticated = !!req.auth?.user?.id;

  if (!isAuthenticated) {
    const loginUrl = new URL('/login', req.nextUrl.origin);
    const destination = `${pathname}${search}`;
    if (destination && destination !== '/') {
      loginUrl.searchParams.set('callbackUrl', destination);
    }
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

// A checagem de PERMISSÃO fina (ex.: pode enviar mensagem? pode apagar
// leads?) não acontece aqui — acontece dentro de cada server action/rota,
// com leitura fresca do banco (src/lib/auth-helpers.ts). Este middleware só
// garante que existe uma sessão válida; é a segunda camada (nas ações) que
// decide o que essa sessão pode fazer, e é ela que vale de verdade mesmo se
// alguém tentar chamar a action diretamente sem passar pela tela.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
