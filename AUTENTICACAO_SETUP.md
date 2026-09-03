# Sistema de Autenticação, Usuários, Permissões e Auditoria — Guia de Instalação e Testes

Este documento cobre tudo que falta rodar **na sua máquina** pra colocar o sistema de login no ar: instalar pacotes, configurar variáveis de ambiente, migrar o banco pro Turso, criar o primeiro usuário e testar antes de apresentar. Nada disso eu consigo rodar por aqui — preciso que você rode os comandos abaixo, na ordem, no terminal do projeto (`C:\Projetos\Projeto Vendas\CRM`).

## 1. Instalar dependências

```powershell
npm install
```

Isso vai instalar `next-auth@5.0.0-beta.32` (versão fixada de propósito — veja a nota de segurança no final) e `bcryptjs`, que já estão no `package.json`.

## 2. Gerar o `AUTH_SECRET`

O Auth.js precisa de um segredo pra assinar os cookies de sessão (JWT). Gere um valor aleatório forte e único — **nunca reaproveite um valor de exemplo**:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copie o valor impresso e adicione ao seu `.env.local` (não ao `.env.example`, e nunca comite esse arquivo):

```
AUTH_SECRET=<valor gerado>
```

## 3. Configurar o Turso (banco persistente)

Você escolheu migrar pro Turso agora, porque o `sqlite.db` local não sobrevive a um deploy na Vercel (cada deploy roda em um filesystem efêmero). Se você **ainda não tem** um banco Turso para este projeto:

```powershell
# instalar a CLI do Turso (uma vez só, se ainda não tiver)
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create sirrus-crm
turso db show sirrus-crm --url
turso db tokens create sirrus-crm
```

O segundo comando imprime a URL (algo como `libsql://sirrus-crm-<sua-org>.turso.io`), o terceiro imprime o token. Adicione os dois ao `.env.local`:

```
TURSO_DATABASE_URL=libsql://sirrus-crm-....turso.io
TURSO_AUTH_TOKEN=<token gerado>
```

Se você **já tem** um banco Turso configurado pra esse projeto, só confirme que essas duas variáveis já estão no `.env.local` com os valores corretos.

> Nota: enquanto essas duas variáveis não estiverem definidas, o app continua caindo no arquivo local `sqlite.db` (fallback que já existia) — então nada quebra se você testar antes de configurar o Turso. Mas pra produção (Vercel) elas são obrigatórias.

## 4. Criar o primeiro usuário (SUPER_ADMIN)

Adicione temporariamente ao `.env.local` (pode remover essas três linhas depois de rodar o script, elas só servem pra esse comando):

```
SUPER_ADMIN_NAME="Seu Nome"
SUPER_ADMIN_EMAIL="voce@exemplo.com"
SUPER_ADMIN_PASSWORD="uma senha forte com 12+ caracteres"
```

Não use senha fraca ou óbvia — o script recusa senhas como `123456`, `admin123` etc.

## 5. Gerar e aplicar a migração do banco

O schema ganhou tabelas novas (`users`, `user_permissions`, `audit_logs`) e uma coluna nova em `leads` (`assigned_user_id`). Gere o SQL de migração e aplique:

```powershell
npx drizzle-kit generate
npm run db:migrate
```

O primeiro comando cria um arquivo `.sql` novo dentro de `drizzle/` (baseado na diferença entre o schema atual e o anterior). O segundo aplica no banco configurado (Turso, se as variáveis estiverem setadas; senão, no `sqlite.db` local).

Depois, crie o SUPER_ADMIN:

```powershell
npm run db:bootstrap-admin
```

Se der certo, você vê `[bootstrap-admin] Usuário SUPER_ADMIN criado com sucesso`. Rodar de novo não duplica nem sobrescreve — ele avisa que o e-mail já existe e não faz nada.

## 6. Rodar e testar localmente

```powershell
npm run dev
```

Abra `http://localhost:3000` — agora qualquer rota deve redirecionar pra `/login` se você não estiver autenticado. Entre com o e-mail/senha do `.env.local`.

### Checklist de teste manual

Marque cada item conforme for testando:

- [ ] Acessar `http://localhost:3000/` sem estar logado → redireciona pra `/login`.
- [ ] Login com e-mail/senha corretos → entra e volta pra página que você tentou acessar.
- [ ] Login com senha errada → mensagem "E-mail ou senha incorretos.", sem detalhar se foi o e-mail ou a senha que errou.
- [ ] Login com e-mail que não existe → mesma mensagem genérica (não revela se o e-mail existe).
- [ ] Depois de logado, a barra lateral mostra seu nome e papel (Super Admin), e um botão de sair funcionando.
- [ ] Ir em **Configurações → Usuários** (ou o item "Usuários" na barra lateral) — deve listar você mesmo.
- [ ] Criar um segundo usuário de teste com papel **Vendedor** e o preset de permissões "Vendedor".
- [ ] Sair (logout) e entrar com esse segundo usuário.
- [ ] Confirmar que esse usuário **não vê** os itens "Usuários" e "Logs de Auditoria" na barra lateral (não tem essas permissões).
- [ ] Confirmar que ele consegue: ver leads, mover no pipeline, gerar mensagem com IA, marcar como enviada.
- [ ] Confirmar que o botão "Limpar Todos os Leads" (ação destrutiva) — se visível — retorna erro de permissão pra esse usuário, já que o preset Vendedor não inclui `LEAD_DELETE_ALL`.
- [ ] Voltar a logar como SUPER_ADMIN e editar o usuário de teste: tentar desativá-lo (status Inativo) → deve funcionar, e o login dele passa a falhar.
- [ ] Reativá-lo.
- [ ] Editando a **própria conta** (SUPER_ADMIN): confirmar que os campos Papel e Status ficam desabilitados, e a aba Permissões fica desabilitada, com o aviso explicando por quê.
- [ ] Tentar deixar o sistema sem nenhum SUPER_ADMIN ativo (se você criar um segundo SUPER_ADMIN e tentar desativar os dois) → o sistema deve bloquear a desativação do último.
- [ ] Ir em **Logs de Auditoria** e confirmar que aparecem entradas para: seu login, a criação do usuário de teste, a mudança de estágio de pipeline, a geração de mensagem com IA.
- [ ] Abrir uma entrada do log (clicar na linha) e confirmar que os detalhes abrem, sem nenhuma senha/token/chave aparecendo em lugar nenhum.
- [ ] Testar o botão "Iniciar Automação" em Configurações — deve continuar funcionando normalmente (a permissão `AUTOMATION_START` está no preset Administrador).
- [ ] Se você usa o worker em segundo plano (`npm run worker`), rodar ele em paralelo e confirmar que ele **continua gerando mensagens e analisando leads automaticamente**, mesmo sem ninguém logado no navegador — essa é a parte mais importante de verificar, porque é a automação que não pode quebrar.
- [ ] Testar o "Texto Institucional" em Configurações de novo, pra garantir que continua sendo considerado na geração (isso já tinha sido confirmado antes, só reconfirmando que nada regrediu).
- [ ] Testar a integração com Instagram (visualizar perfil / preparar DM) pra garantir que os botões continuam funcionando pra quem tem permissão.

## 7. Rodar as verificações de código

```powershell
npm run lint
npm run typecheck
npm run build
```

Rode os três e me mande a saída exata de qualquer erro — corrijo o que for relacionado a esta implementação.

## 8. Limpar os endpoints de diagnóstico temporários

Durante o desenvolvimento foram criados alguns endpoints de teste que mutam dados sem passar pelas permissões granulares (ficaram restritos a SUPER_ADMIN nesta entrega, mas o ideal é apagar depois de usar). Depois de testar tudo, apague estas pastas:

```powershell
Remove-Item -Recurse -Force "src\app\api\test-latency"
Remove-Item -Recurse -Force "src\app\api\test-institutional-text"
Remove-Item -Recurse -Force "src\app\api\test-analyze"
Remove-Item -Recurse -Force "src\app\api\seed-real-restaurants"
```

(O `seed-real-restaurants` foi um achado extra da auditoria de segurança — não tinha sido mencionado antes, mas é a mesma classe de risco: endpoint que insere dados reais sem nenhuma permissão granular.)

## 9. Configurar a Vercel (quando for fazer o deploy)

No painel do projeto na Vercel, em Settings → Environment Variables, adicione:

- `AUTH_SECRET` — o mesmo valor gerado no passo 2 (ou gere um novo específico pra produção)
- `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` — os mesmos do passo 3
- Todas as variáveis que já existiam antes (OpenRouter, Meta API, etc.)

Depois do primeiro deploy, rode a migração e o bootstrap do admin **apontando pro banco de produção** (as mesmas variáveis Turso already fazem isso — não tem "banco de produção" separado, é o mesmo Turso). Ou seja, os passos 5 e 6 já cobrem produção também, contanto que `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` estejam configuradas no `.env.local` antes de rodar.

## O que ficou de fora (de propósito, pra não estourar o escopo)

- **Isolamento de leads por vendedor**: a coluna `assignedUserId` e a permissão `VIEW_ALL_LEADS` já existem no schema/catálogo, mas as telas (Fila de Prospecção, Leads, Pipeline) ainda mostram todos os leads pra todo mundo — a filtragem por dono ainda não foi ligada nas consultas. Isso foi tratado como preparação para multiusuário, não como o recurso completo. Se quiser isso pra apresentação de amanhã, me avise que priorizo.
- **Reset de senha por e-mail**: não existe envio de e-mail configurado no projeto, então a única forma de trocar a senha de alguém é o SUPER_ADMIN/Admin definindo uma nova diretamente na tela de Usuários.
- `analyzeLeadAction`, `generateMessageAction` (as funções originais, não as versões `*Authorized`) e `disambiguateInstagramCandidates` continuam **sem** checagem de permissão — de propósito, porque são chamadas diretamente pelo processo de automação em segundo plano (`scripts/browser-worker.ts`), que roda fora de qualquer sessão HTTP. A tela de Fila de Prospecção usa as versões `*Authorized`, que fazem a checagem. Isso está documentado em comentário no topo de `src/app/actions/ai.ts`.

## Nota de segurança aplicada

O `next-auth` foi fixado na versão `5.0.0-beta.32` (não numa faixa `^5.0.0-beta.x`) porque versões anteriores da v5 (`5.0.0-beta.0` até `5.0.0-beta.31`) têm uma vulnerabilidade conhecida (GHSA-8fpg-xm3f-6cx3): uma configuração quebrada (por exemplo, `AUTH_SECRET` ausente) podia fazer o objeto de sessão virar um objeto de erro "truthy" em vez de `null`, autenticando todo mundo por engano em checagens do tipo `if (session)`. Por isso: (1) a versão está fixada acima da correção, (2) `src/auth.ts` valida a presença de `AUTH_SECRET` no boot e recusa subir sem ela, e (3) `src/middleware.ts` sempre checa `req.auth?.user?.id` (um campo concreto), nunca `!!req.auth`.
