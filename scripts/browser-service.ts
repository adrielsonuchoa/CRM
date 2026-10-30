// Servico HTTP do navegador (Chrome/Instagram) para rodar num servidor
// persistente (VPS) que fica sempre ligado, com o Chrome instalado e logado
// no Instagram. A aplicacao web (rodando na Vercel ou em qualquer outro
// lugar) chama este servico pela internet, autenticado por token, sempre
// que precisa executar uma acao que depende de um navegador real.
//
// Rode com: npm run browser-service
//
// Variaveis de ambiente necessarias, alem das ja usadas por "npm run worker"
// (TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, CHROME_CDP_URL ou
// CHROME_USER_DATA_DIR/CHROME_EXECUTABLE_PATH, etc.):
//   BROWSER_SERVICE_TOKEN  -> segredo compartilhado; a Vercel precisa enviar
//                             o mesmo valor no cabecalho Authorization.
//   BROWSER_SERVICE_PORT   -> porta HTTP (padrao 8787).
//
// IMPORTANTE: este processo NUNCA deve rodar com BROWSER_SERVICE_URL
// configurada no seu proprio ambiente — se estiver, ele tentaria encaminhar
// as chamadas para si mesmo (proxy) em vez de executar localmente. Deixe
// BROWSER_SERVICE_URL de fora do .env deste servidor.

import http from 'http';
import {
  checkChromeConnection,
  enrichLeadViaBrowser,
  previewInstagramProfileViaBrowser,
  warmupQueueLeadsViaBrowser,
  sendFirstDmViaBrowser,
  confirmPreparedDmViaBrowser,
  cancelPreparedDmViaBrowser,
  startWorker,
  pauseWorker,
} from '../src/lib/browser-worker';

const PORT = Number(process.env.BROWSER_SERVICE_PORT ?? 8787);
const TOKEN = process.env.BROWSER_SERVICE_TOKEN?.trim();

if (!TOKEN) {
  console.error('[BROWSER-SERVICE] BROWSER_SERVICE_TOKEN nao configurado. Recuso iniciar sem autenticacao — configure essa variavel antes de rodar este servico.');
  process.exit(1);
}

if (process.env.BROWSER_SERVICE_URL?.trim()) {
  console.error('[BROWSER-SERVICE] BROWSER_SERVICE_URL esta definida no ambiente deste processo. Remova-a — este e o servico de destino, ele nao deve encaminhar chamadas para si mesmo.');
  process.exit(1);
}

type Handler = (body: any) => Promise<unknown>;

const routes: Record<string, Handler> = {
  '/check-connection': () => checkChromeConnection(),
  '/enrich-lead': (body) => enrichLeadViaBrowser(body?.leadId),
  '/preview-profile': (body) => previewInstagramProfileViaBrowser(body?.leadId),
  '/send-first-dm': (body) => sendFirstDmViaBrowser(body?.leadId, body?.requestedMessage),
  '/confirm-dm': (body) => confirmPreparedDmViaBrowser(body?.leadId, body?.requestedMessage),
  '/cancel-dm': (body) => cancelPreparedDmViaBrowser(body?.leadId),
  '/warmup-queue': (body) => warmupQueueLeadsViaBrowser(Array.isArray(body?.leadIds) ? body.leadIds.map(String) : []),
  '/worker/start': () => startWorker(),
  '/worker/pause': () => pauseWorker(),
};

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Corpo da requisicao muito grande.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON invalido.'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  if (path === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const auth = req.headers.authorization ?? '';
  const providedToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (providedToken !== TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Nao autorizado.' }));
    return;
  }

  const handler = req.method === 'POST' ? routes[path] : undefined;
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rota nao encontrada.' }));
    return;
  }

  try {
    const body = await readBody(req);
    const result = await handler(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err: any) {
    console.error(`[BROWSER-SERVICE] Erro em ${path}:`, err?.message ?? err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err?.message ?? 'Falha interna no servico de navegador.' }));
  }
});

server.listen(PORT, () => {
  console.log(`[BROWSER-SERVICE] Ouvindo na porta ${PORT}. Rotas protegidas por BROWSER_SERVICE_TOKEN.`);
});
