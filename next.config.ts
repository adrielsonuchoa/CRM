import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  // "standalone": produz .next/standalone com um server.js autocontido e só
  // os node_modules realmente usados - é o que permite rodar no PC do
  // cliente com um Node portátil, sem precisar de npm install lá.
  // Na Vercel fica desligado: ela tem o proprio empacotamento, e com
  // standalone ligado a etapa final do build dela falha procurando
  // .next/next-server.js.nft.json.
  output: process.env.VERCEL ? undefined : 'standalone',
  // O rastreamento de arquivos do Next só segue imports de código; as
  // migrações do Drizzle são lidas do disco em tempo de execução (ver
  // src/instrumentation.ts), então precisam ser incluídas explicitamente
  // para sobreviver ao build standalone.
  outputFileTracingIncludes: {
    // As migrações do Drizzle são lidas do disco em tempo de execução (ver
    // src/instrumentation.ts) - não sobrevivem ao rastreamento de imports.
    //
    // playwright-core resolve alguns dos seus próprios arquivos (ex.:
    // browsers.json, o driver embutido) com require() dinâmico, que o
    // rastreador de arquivos do build standalone não consegue seguir - sem
    // forçar a pasta inteira aqui, o pacote fica pela metade no
    // .next/standalone e o CDP nunca carrega no PC do cliente.
    '/': ['./drizzle/**/*', './node_modules/playwright-core/**/*', './node_modules/playwright/**/*'],
  },
  // Evita que o bundler tente empacotar/otimizar esses pacotes (que têm
  // binários e requires dinâmicos) - fica como dependência normal de
  // node_modules, resolvida em runtime.
  serverExternalPackages: ['playwright', 'playwright-core'],
};

export default nextConfig;
