# Servico de navegador (Instagram) para produção — runbook

Este documento é a continuação de `AUTENTICACAO_SETUP.md`. Ele existe porque a
aplicação web (hoje hospedada na Vercel) **não consegue** rodar a automação de
navegador (Playwright/Chrome CDP) — Vercel é serverless: cada requisição pode
cair num container novo, sem Chrome instalado e sem sessão persistente. A
correção é rodar o Chrome + a automação num servidor separado, sempre ligado,
e a aplicação web chama esse servidor pela internet quando precisa.

## O que já foi feito no código

- `src/lib/browser-worker.ts`: todas as funções que dependem de um Chrome real
  (`checkChromeConnection`, `enrichLeadViaBrowser`,
  `previewInstagramProfileViaBrowser`, `sendFirstDmViaBrowser`,
  `confirmPreparedDmViaBrowser`, `cancelPreparedDmViaBrowser`, `startWorker`,
  `pauseWorker`) agora verificam se `BROWSER_SERVICE_URL` está configurada.
  Se estiver, encaminham a chamada por HTTP para o servidor persistente em
  vez de tentar abrir um Chrome local (que não existe na Vercel). Se não
  estiver, continuam funcionando exatamente como antes (uso local).
- `scripts/browser-service.ts` (novo): um servidor HTTP simples que expõe
  essas mesmas ações, protegido por um token. É isso que roda no servidor
  persistente.
- `.env.example`: documentadas as novas variáveis (`BROWSER_SERVICE_URL`,
  `BROWSER_SERVICE_TOKEN`, `BROWSER_SERVICE_PORT`).
- `tsc --noEmit` rodou sem erros depois dessas mudanças.

**Antes de continuar**, suba só esses arquivos (evite `git add -A` — o
repositório tem um problema à parte de fim de linha CRLF/LF que faz o
`git status` mostrar quase tudo como modificado; isso não tem relação com
esta mudança):

```
git add src/lib/browser-worker.ts scripts/browser-service.ts package.json .env.example
git commit -m "feat: adiciona servico remoto de navegador para acoes de Instagram na Vercel"
git push
```

## Passo a passo: montando o servidor persistente

### 1. Contrate um servidor (VPS)

Qualquer provedor serve; o mais barato já é suficiente (1 vCPU / 1-2 GB RAM).
Sugestões: DigitalOcean, Hetzner, Vultr — todos com opção Ubuntu 22.04 por
volta de US$ 5-6/mês. Se você já tem conta em algum provedor de nuvem, use
ele; senão, qualquer um desses serve pra começar.

Ao criar, anote o **IP público** da máquina.

### 2. Conecte via SSH e instale as dependências

```bash
ssh root@SEU_IP_AQUI

apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git xvfb x11vnc fluxbox
```

`xvfb` cria uma "tela" falsa (o servidor não tem monitor); `x11vnc` deixa
você acessar essa tela remotamente por um instante, só pra fazer o login do
Instagram uma vez; `fluxbox` é um gerenciador de janelas leve.

### 3. Clone o projeto e instale

```bash
git clone SEU_REPOSITORIO_AQUI crm
cd crm
npm install
npx playwright install --with-deps chromium
```

### 4. Configure o `.env`

Crie `.env.local` nessa máquina com:

```
TURSO_DATABASE_URL=...        # mesmo valor da Vercel
TURSO_AUTH_TOKEN=...          # mesmo valor da Vercel
OPENROUTER_API_KEY=...        # mesmo valor da Vercel (se a IA rodar por aqui)
GEOAPIFY_API_KEY=...

CHROME_USER_DATA_DIR=/root/chrome-profile
CHROME_EXECUTABLE_PATH=/root/.cache/ms-playwright/chromium-*/chrome-linux/chrome
PROSPECTION_DRY_RUN=true
MAX_FIRST_DMS_PER_DAY=5

BROWSER_SERVICE_TOKEN=GERE_UM_TOKEN_LONGO_E_ALEATORIO_AQUI
BROWSER_SERVICE_PORT=8787
```

Gere o token com: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

**Não** coloque `BROWSER_SERVICE_URL` no `.env` desta máquina — essa variável
é só pro lado da Vercel (ela aponta pra cá; se você configurar aqui também,
esta máquina tentaria encaminhar as chamadas pra si mesma).

Ajuste `CHROME_EXECUTABLE_PATH` pro caminho real que o Playwright instalou —
depois do `npx playwright install`, rode `find / -name "chrome" -path
"*chrome-linux*" 2>/dev/null` pra achar o caminho exato.

### 5. Faça o login único no Instagram

```bash
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99
fluxbox &
x11vnc -display :99 -nopw -listen 0.0.0.0 -xkb &
```

Agora, do seu computador, abra um cliente VNC (ex.: RealVNC Viewer, TigerVNC)
e conecte em `SEU_IP_AQUI:5900`. Você vai ver a tela virtual do servidor.

Dentro dela, abra o Chrome manualmente apontando pro mesmo perfil:

```bash
$CHROME_EXECUTABLE_PATH --user-data-dir=$CHROME_USER_DATA_DIR --remote-debugging-port=9222
```

Loga no Instagram normalmente, na página real deles. Depois de logado, pode
fechar a conexão VNC — a sessão fica salva em `CHROME_USER_DATA_DIR`.

**Assim que terminar o login, desligue o `x11vnc`** (`pkill x11vnc`) — não
deixe essa porta de acesso remoto aberta depois desse passo único; ela não
tem senha por padrão do jeito que está acima.

### 6. Deixe os dois processos rodando sempre

Crie dois serviços systemd:

`/etc/systemd/system/crm-worker.service`:
```ini
[Unit]
Description=CRM - worker de prospeccao
After=network.target

[Service]
WorkingDirectory=/root/crm
ExecStart=/usr/bin/npm run worker
Restart=always
Environment=DISPLAY=:99

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/crm-browser-service.service`:
```ini
[Unit]
Description=CRM - servico HTTP do navegador
After=network.target

[Service]
WorkingDirectory=/root/crm
ExecStart=/usr/bin/npm run browser-service
Restart=always
Environment=DISPLAY=:99

[Install]
WantedBy=multi-user.target
```

E mantenha o Xvfb rodando também via systemd (ou adicione ele como
dependência dos dois serviços acima). Depois:

```bash
systemctl daemon-reload
systemctl enable --now crm-worker crm-browser-service
```

### 7. Abra a porta do servico (com cuidado)

```bash
ufw allow 22
ufw allow 8787
ufw enable
```

O endpoint em si já exige o `BROWSER_SERVICE_TOKEN` em todo pedido — sem o
token certo, tudo retorna 401. Ainda assim, o ideal é colocar isso atrás de
HTTPS (um proxy reverso com Caddy ou nginx + Let's Encrypt, apontando um
domínio ou subdomínio pra esse IP) em vez de expor a porta 8787 crua — fica
pra uma segunda etapa, mas registre isso como pendência de segurança.

### 8. Configure a Vercel

Em Project Settings → Environment Variables, adicione:

```
BROWSER_SERVICE_URL=http://SEU_IP_AQUI:8787       (ou https://seu-dominio, se configurar o proxy)
BROWSER_SERVICE_TOKEN=O_MESMO_TOKEN_DO_PASSO_4
```

Redeploy. A partir daí, os botões "Buscar Instagram", "Preparar DM" etc. no
painel hospedado na Vercel vão encaminhar a ação pra esse servidor e mostrar
o resultado real.

## Testando

```bash
curl -X POST http://SEU_IP_AQUI:8787/check-connection \
  -H "Authorization: Bearer O_TOKEN" -H "Content-Type: application/json" -d '{}'
```

Deve responder algo como `{"connected":true,"username":"..."}`. Se dessa
chamada já funcionar, o painel na Vercel também vai funcionar.
