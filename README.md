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
OPENAI_API_KEY
GEOAPIFY_API_KEY
CHROME_CDP_URL
META_ACCESS_TOKEN
META_APP_SECRET
META_WEBHOOK_VERIFY_TOKEN
INSTAGRAM_ACCOUNT_ID
INSTAGRAM_USERNAME
PROSPECTION_DRY_RUN=true
AUTO_REPLY=false
```

Na tela Configuracoes, selecione Geoapify Places como fonte principal. A chave e obtida no painel do Geoapify em https://myprojects.geoapify.com/ e deve ser adicionada somente ao `.env.local` como `GEOAPIFY_API_KEY`. Instagram e Lista manual podem ser habilitados junto com Geoapify.

O CSV manual aceita as colunas `nome`, `instagram`, `telefone`, `website`, `cidade` e `segmento`.

Nao exponha secrets no frontend. O endpoint `/api/health` retorna apenas flags booleanas nao sensiveis.

## Modo de teste

O modo de teste vem ativo por padrao em Configuracoes. Nesse modo:

```text
Pesquisa: sim
Analise: sim
Fila: sim
Mensagem IA: sim
Envio real: nao
```
