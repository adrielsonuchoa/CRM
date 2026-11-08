# Sirrus CRM

CRM de prospeccao comercial com Next.js, Drizzle/SQLite, OpenAI, Geoapify Places, Meta Webhook e Browser Worker via Chrome CDP.

## Arquitetura

A aplicacao web pode rodar na Vercel ou em um servidor Node.js. O Browser Worker deve rodar em uma maquina persistente com Chrome disponivel, porque `CHROME_CDP_URL=http://localhost:9222` aponta para a maquina onde o worker esta executando, nao para a Vercel.

Fluxo recomendado:

```text
Vercel / Next.js app
  + banco compartilhado
  + Meta Webhook

Maquina persistente do worker
  + npm run worker
  + Chrome iniciado com CDP
  + mesmas variaveis de banco/OpenAI usadas pela aplicacao
```

## Instalar e migrar

```bash
npm install
npm run db:migrate
```

## Iniciar aplicacao

```bash
npm run dev
```

Producao Node.js:

```bash
npm run build
npm run start
```

## Iniciar Chrome com CDP

No Windows, copie `Claude outputs/Iniciar CRM-1.bat` **e**
`Claude outputs/Iniciar CRM.ps1` juntos (os dois precisam estar na mesma
pasta) para a Area de Trabalho do cliente. O `.bat` inicia o Chrome em um
perfil dedicado (`C:\\ChromeCRM`) com CDP na porta 9222 e abre o CRM; ele
detecta o Chrome mesmo em instalacoes sem admin, evita abrir uma segunda
instancia conflitante no mesmo perfil, e so inicia o `npm run dev` se ainda
nao estiver rodando. Depois do primeiro login (via
`Claude outputs/Login Instagram (uma vez so).bat`), mantenha a janela do
Chrome aberta durante a prospeccao. O worker reaproveita os cookies do
Instagram desse perfil; nao e necessario informar usuario ou senha no CRM.

Windows PowerShell:

```powershell
Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222 --user-data-dir=$env:TEMP\sirrus-crm-chrome"
```

macOS:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/sirrus-crm-chrome
```

Linux:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/sirrus-crm-chrome
```

Abra o Instagram nesse Chrome e autentique manualmente. O sistema nao implementa bypass de CAPTCHA, rate limit, bloqueio ou desafio de seguranca; se isso aparecer, o worker pausa.

## Iniciar Browser Worker

Na maquina onde o Chrome com CDP esta rodando:

```bash
set CHROME_CDP_URL=http://localhost:9222
npm run worker
```

PowerShell:

```powershell
$env:CHROME_CDP_URL="http://localhost:9222"
npm run worker
```

## Variaveis de ambiente

Obrigatorias conforme o uso:

```text
DATABASE_URL ou TURSO_DATABASE_URL
TURSO_AUTH_TOKEN
OPENROUTER_API_KEY (IA usada so na busca e qualificacao de leads)
GEOAPIFY_API_KEY
CHROME_CDP_URL
META_ACCESS_TOKEN
META_APP_SECRET
META_WEBHOOK_VERIFY_TOKEN
INSTAGRAM_ACCOUNT_ID
INSTAGRAM_USERNAME
PROSPECTION_DRY_RUN=true
```

Na tela Configuracoes, selecione Geoapify Places como fonte principal. A chave e obtida no painel do Geoapify em https://myprojects.geoapify.com/ e deve ser adicionada somente ao `.env.local` como `GEOAPIFY_API_KEY`. Instagram e Lista manual podem ser habilitados junto com Geoapify.

O CSV manual aceita as colunas `nome`, `instagram`, `telefone`, `website`, `cidade` e `segmento`, separadas por `,` ou `;` (detectado automaticamente). O CSV exportado na tela Leads usa os mesmos nomes de coluna e pode ser reimportado.

## Prospeccao pelo Google Maps (Google Maps Scraper)

Integra o [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper) rodando em modo web (padrao `http://localhost:8080`, configuravel em `GOOGLE_MAPS_SCRAPER_URL`):

```bash
docker run -p 8080:8080 gosom/google-maps-scraper -web -data-folder /gmapsdata
```

A busca roda no scraper e leva alguns minutos, por isso a rota tem dois passos (exige login e a permissao de iniciar automacao):

```text
POST /api/v1/prospeccao/google-maps   {"cidade": "Maceió", "bairro": "Ponta Verde", "nicho": "pizzaria"}
  -> 202 {"jobId": "..."}
GET  /api/v1/prospeccao/google-maps?jobId=...
  -> 202 enquanto roda; 200 com {criados, atualizados, ignorados} quando termina
```

Cada estabelecimento vira um lead (fonte `GOOGLE_MAPS`) com telefone, e-mail (extraido pelo scraper do site), WhatsApp (link wa.me do site ou celular), Instagram e Facebook (lidos do site, com cache). Se o lead ja existe - mesmo `place_id` do Google ou mesmo telefone, em qualquer formato - ele e atualizado: campos vazios sao completados e nota/avaliacoes renovadas, sem mexer em estagio, notas ou dados ja preenchidos. O banco tambem tem indice UNIQUE em `place_id` e `phone`.

Na Vercel, `localhost:8080` nao existe: a rota so funciona onde o scraper estiver acessivel (pacote local/maquina do worker, ou um `GOOGLE_MAPS_SCRAPER_URL` publico).

## Cache de pesquisas (Redis)

Pesquisas repetidas (geocode e paginas do Geoapify, Instagram no site do negocio, buscas Bing/DuckDuckGo e perfis do Instagram) ficam em cache e nao sao refeitas. Configure **uma** das opcoes:

```text
REDIS_URL=redis://default:SENHA@host:porta     (Redis Cloud, Docker etc.)
UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Upstash REST)
```

Sem nenhuma, o cache fica em memoria (some ao reiniciar). Use o mesmo Redis na Vercel e na maquina do worker. Se o Redis cair, as pesquisas continuam funcionando sem cache. `/api/health` informa `cacheRedisConfigured`.

## Follow-ups e tarefas

Ao registrar um envio (DM, WhatsApp ou e-mail), o CRM conclui o follow-up pendente do lead e agenda o proximo, conforme Configuracoes (`dias entre follow-ups` e `maximo de follow-ups`). Se o lead responder, mudar de estagio ou for marcado como Nao Contatar, os follow-ups pendentes sao cancelados. A tela **Tarefas** lista atrasadas, de hoje e proximas; tarefas manuais podem ser criadas no detalhe do lead.

## Testes e CI

```bash
npm test              # unitarios + integracao (SQLite temporario, sem chaves de API)
npm run test:automation  # checagem do worker/Chrome/Meta no ambiente atual
```

O GitHub Actions (`.github/workflows/ci.yml`) roda lint, typecheck, testes e build a cada push na `main` e em pull requests.

Nao exponha secrets no frontend. O endpoint `/api/health` retorna apenas flags booleanas nao sensiveis.

## Modo de teste

O modo de teste vem ativo por padrao em Configuracoes. Nesse modo:

```text
Pesquisa: sim
Analise: sim
Fila: sim
Mensagem: escrita pelo usuario (ou modelo fixo, sem IA)
Envio real: nao
```
