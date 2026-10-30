import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema';

const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || 'file:sqlite.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

// O `timeout` do Config so vale pra bancos locais (file:) - clientes remotos
// (Turso via HTTP) o ignoram (documentado no proprio pacote). Sem isso, uma
// falha transitoria de rede/DNS (ja aconteceu de verdade: getaddrinfo
// ENOTFOUND pro host do Turso) deixa a requisicao PENDURADA por tempo
// indefinido em vez de falhar rapido - e como todo o resto do codigo
// (runTargetedProspecting, runProspectingOnce etc.) so consegue reagir a um
// erro DEPOIS que a Promise resolve/rejeita, uma unica chamada travada
// congela a busca inteira pra sempre (progressRunId nunca mais zera, o botao
// "Buscar Leads" fica preso em "Buscando..." ate reiniciar o servidor).
// Contornado com um `fetch` customizado com timeout, unica opcao exposta
// pelo cliente HTTP.
const DB_REQUEST_TIMEOUT_MS = 20_000;

const client = createClient({
  url,
  authToken: authToken || undefined,
  fetch: (input: any, init?: any) => fetch(input, { ...init, signal: AbortSignal.timeout(DB_REQUEST_TIMEOUT_MS) }),
});

export const db = drizzle(client, { schema });
