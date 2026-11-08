import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// Integracao: scraper falso (mesma API do gosom/google-maps-scraper) + site de
// restaurante falso + SQLite temporario com todas as migracoes.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-gmaps-'));
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.REDIS_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
process.env.DATABASE_URL = `file:${path.join(tmpDir, 'test.db').replace(/\\/g, '/')}`;

const CSV_HEADER = 'input_id,link,title,category,address,open_hours,website,phone,review_count,review_rating,cid,data_id,place_id,complete_address,emails';
let csvBody = '';
let jobStatus = 'working';
const createdJobs: any[] = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/api/v1/jobs') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      createdJobs.push(JSON.parse(body));
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: '11111111-2222-3333-4444-555555555555' }));
    });
    return;
  }
  if (url.pathname === '/api/v1/jobs/11111111-2222-3333-4444-555555555555') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ID: '1', Status: jobStatus }));
    return;
  }
  if (url.pathname === '/api/v1/jobs/11111111-2222-3333-4444-555555555555/download') {
    res.writeHead(200, { 'Content-Type': 'text/csv' }).end(`${CSV_HEADER}\n${csvBody}`);
    return;
  }
  if (url.pathname === '/site-bella') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(
      '<a href="https://www.instagram.com/pizzariabella/">IG</a><a href="https://www.facebook.com/PizzariaBella">FB</a><a href="https://wa.me/5582988887777">Zap</a>',
    );
    return;
  }
  res.writeHead(404).end();
});

let base = '';
type Modules = {
  scraper: typeof import('@/lib/google-maps-scraper');
  db: typeof import('@/db').db;
  schema: typeof import('@/db/schema');
  orm: typeof import('drizzle-orm');
};
let m: Modules;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.GOOGLE_MAPS_SCRAPER_URL = base;

  const { db } = await import('@/db');
  const { migrate } = await import('drizzle-orm/libsql/migrator');
  const { ensureLegacyColumns } = await import('@/db/ensure-columns');
  await migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
  await ensureLegacyColumns(db.$client);
  m = { db, scraper: await import('@/lib/google-maps-scraper'), schema: await import('@/db/schema'), orm: await import('drizzle-orm') };
});

after(() => {
  server.close();
  m?.db.$client.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function csvLine(values: string[]) {
  return values.map((value) => `"${value.replace(/"/g, '""')}"`).join(',');
}

test('cria o job no scraper com e-mail habilitado e palavra-chave do nicho/bairro/cidade', async () => {
  const { jobId, keyword } = await m.scraper.createScraperJob({ cidade: 'Maceió', bairro: 'Ponta Verde', nicho: 'pizzaria' });
  assert.equal(jobId, '11111111-2222-3333-4444-555555555555');
  assert.equal(keyword, 'pizzaria em Ponta Verde, Maceió');
  assert.deepEqual(createdJobs[0].keywords, ['pizzaria em Ponta Verde, Maceió']);
  assert.equal(createdJobs[0].email, true);
  assert.equal(createdJobs[0].lang, 'pt');
  assert.equal(createdJobs[0].max_time, 600);
  assert.equal(await m.scraper.getScraperJobStatus(jobId), 'working');
});

test('importa: cria leads, extrai redes sociais do site e detecta WhatsApp', async () => {
  jobStatus = 'ok';
  csvBody = [
    csvLine(['1', 'https://maps.google.com/?cid=1', 'Pizzaria Bella', 'Pizzaria', 'Rua A, 10 - Ponta Verde', '{"seg": ["18h-23h"],\n"ter": []}', `${base}/site-bella`, '+55 82 3221-0901', '154', '4,6', '1', 'd1', 'ChIJbella', '{"borough":"Ponta Verde","city":"Maceió","state":"AL"}', 'contato@bella.com.br']),
    csvLine(['1', 'https://maps.google.com/?cid=2', 'Bar do Zé', 'Bar', 'Rua B, 20', '', 'https://instagram.com/bardoze', '(82) 99999-1234', '10', '4.1', '2', 'd2', 'ChIJbar', '', '']),
    csvLine(['1', '', '', 'Bar', '', '', '', '', '', '', '', '', '', '', '']),
  ].join('\n');
  assert.equal(await m.scraper.getScraperJobStatus('11111111-2222-3333-4444-555555555555'), 'ok');
  const places = m.scraper.parseScraperCsv(await m.scraper.downloadScraperCsv('11111111-2222-3333-4444-555555555555'), { cidade: 'Maceió', bairro: 'Ponta Verde' });
  assert.equal(places.length, 2, 'linha sem nome e descartada');

  const result = await m.scraper.importScrapedPlaces(places, { nicho: 'pizzaria', keyword: 'pizzaria em Ponta Verde, Maceió' });
  assert.equal(result.criados, 2);
  assert.equal(result.erros.length, 0);

  const { leads } = m.schema;
  const bella = (await m.db.select().from(leads).where(m.orm.eq(leads.placeId, 'ChIJbella')))[0];
  assert.equal(bella.businessName, 'Pizzaria Bella');
  assert.equal(bella.instagramUsername, 'pizzariabella');
  assert.equal(bella.facebookUrl, 'https://www.facebook.com/PizzariaBella');
  assert.equal(bella.whatsapp, '5582988887777', 'WhatsApp do link wa.me do site');
  assert.equal(bella.email, 'contato@bella.com.br');
  assert.equal(bella.neighborhood, 'Ponta Verde');
  assert.equal(bella.rating, 4.6);
  assert.equal(bella.reviewCount, 154);
  assert.equal(bella.source, 'GOOGLE_MAPS');
  assert.equal(bella.pipelineStage, 'DESCOBERTO');

  const bar = (await m.db.select().from(leads).where(m.orm.eq(leads.placeId, 'ChIJbar')))[0];
  assert.equal(bar.instagramUsername, 'bardoze', 'site cadastrado era o proprio Instagram');
  assert.equal(bar.website, null);
  assert.equal(bar.whatsapp, '5582999991234', 'celular vira WhatsApp');
});

test('reimportar atualiza em vez de duplicar (por place_id e por telefone)', async () => {
  const { leads } = m.schema;
  // Usuario ja tinha mexido no lead: estagio e notas nao podem ser perdidos.
  await m.db.update(leads).set({ pipelineStage: 'CONTATO REALIZADO', notes: 'ligar a tarde' }).where(m.orm.eq(leads.placeId, 'ChIJbella'));

  const places = [
    // Mesmo place_id, nota nova.
    { ...m.scraper.parseScraperCsv(`${CSV_HEADER}\n${csvLine(['1', '', 'Pizzaria Bella', 'Pizzaria', '', '', '', '+55 82 3221-0901', '200', '4.8', '', '', 'ChIJbella', '', ''])}`)[0] },
    // Sem place_id, mas mesmo telefone do Bar do Zé em outro formato.
    { ...m.scraper.parseScraperCsv(`${CSV_HEADER}\n${csvLine(['1', '', 'Bar do Zé (filial)', 'Bar', '', '', '', '+55 82 99999-1234', '', '', '', '', '', '', 'bar@ze.com'])}`)[0], placeId: null },
  ];
  const result = await m.scraper.importScrapedPlaces(places, { nicho: 'bar', keyword: 'bar em Maceió' });
  assert.equal(result.criados, 0);
  assert.equal(result.atualizados, 2);

  const all = await m.db.select().from(leads);
  assert.equal(all.length, 2, 'nada duplicado');
  const bella = all.find((lead) => lead.placeId === 'ChIJbella')!;
  assert.equal(bella.rating, 4.8, 'nota renovada');
  assert.equal(bella.reviewCount, 200);
  assert.equal(bella.pipelineStage, 'CONTATO REALIZADO', 'estagio preservado');
  assert.equal(bella.notes, 'ligar a tarde', 'notas preservadas');
  assert.equal(bella.instagramUsername, 'pizzariabella', 'dado existente nao e apagado');
  const bar = all.find((lead) => lead.placeId === 'ChIJbar')!;
  assert.equal(bar.businessName, 'Bar do Zé', 'nome original mantido');
  assert.equal(bar.email, 'bar@ze.com', 'campo vazio completado');
});

test('scraper fora do ar gera erro claro', async () => {
  process.env.GOOGLE_MAPS_SCRAPER_URL = 'http://127.0.0.1:9';
  await assert.rejects(m.scraper.createScraperJob({ cidade: 'Maceió', nicho: 'bar' }), /indisponível/);
  process.env.GOOGLE_MAPS_SCRAPER_URL = base;
});
