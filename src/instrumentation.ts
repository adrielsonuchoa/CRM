// Em pacotes de cliente gerados por scripts/prepare-client-installer.ps1, o
// .env.local real (segredos: TURSO_AUTH_TOKEN, AUTH_SECRET etc.) pode ter
// sido movido pra um caminho oculto fora da raiz do projeto (ex.:
// drizzle/meta/Node/.env.local), pra dificultar acesso casual à pasta. O
// carregamento automático de env do Next só olha a raiz, então isso preenche
// manualmente o que faltar — sem nunca sobrescrever uma env var que já veio
// de outro lugar (raiz, ou variável de ambiente real do processo).
async function loadHiddenEnvFallback() {
  const path = await import('path');
  const fs = await import('fs');
  const hiddenEnvPath = path.join(process.cwd(), 'drizzle', 'meta', 'Node', '.env.local');
  let envText: string;
  try {
    envText = fs.readFileSync(hiddenEnvPath, 'utf8');
  } catch {
    return; // Sem arquivo oculto (ex.: ambiente de dev normal) - nada a fazer.
  }
  for (const rawLine of envText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  await loadHiddenEnvFallback();

  // Aplica as migrações do banco automaticamente ao subir o servidor.
  // Idempotente (o drizzle-orm guarda o que já rodou em uma tabela de
  // controle) - seguro rodar toda vez que o processo inicia. Existe pra que
  // o PC do cliente (que não tem Node/npm/drizzle-kit instalado, só o build
  // standalone) nunca precise de um passo manual de "npm run db:migrate".
  const { db } = await import('@/db');
  const { migrate } = await import('drizzle-orm/libsql/migrator');
  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('[instrumentation] Migracoes do banco aplicadas.');
  } catch (err) {
    console.error('[instrumentation] Falha ao aplicar migracoes do banco:', err);
  }

  // Retoma a automacao sozinha se o servidor foi reiniciado enquanto ela
  // estava rodando (ver comentario em resumeWorkerIfNeeded) - sem isso, um
  // reinicio (deploy, crash, PC reiniciado) para a prospeccao em silencio e
  // ninguem percebe ate reparar que nenhum lead novo esta chegando.
  //
  // Sem await: o Next so comeca a responder requisicoes depois que register()
  // termina, e retomar a automacao faz varias idas ao banco remoto (e pode
  // conectar no Chrome) - isso atrasava a PRIMEIRA abertura da tela sem
  // nenhum motivo. Roda em segundo plano, logo depois das migracoes.
  void import('@/lib/browser-worker')
    .then(({ resumeWorkerIfNeeded }) => resumeWorkerIfNeeded())
    .catch((err) => {
      console.error('[instrumentation] Falha ao retomar automacao:', err);
    });
}
