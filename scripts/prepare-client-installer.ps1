# prepare-client-installer.ps1
# Roda NA SUA MAQUINA (dev), nao no PC do cliente. Gera uma pasta/zip pronta
# pra copiar pro PC do cliente: build de producao do CRM + Node.js portatil
# embutido + banco ja migrado com o usuario admin do cliente ja criado. O
# cliente so extrai o zip e da duplo-clique em "Iniciar CRM-1.bat" - nunca
# precisa instalar Node, npm, nem rodar nenhum comando.
#
# Uso (conta nova, criada agora):
#   .\scripts\prepare-client-installer.ps1 -ClienteNome "Restaurante Tal" `
#       -AdminNome "Fulano" -AdminEmail "fulano@exemplo.com" -AdminSenha "SenhaForteAqui123"
#
# Uso (conta que ja existe no Turso, com senha ja definida):
#   .\scripts\prepare-client-installer.ps1 -ClienteNome "Sirrus" -ExportarEmailExistente "sirrus@sirrus.com.br"
#
# Repita pra cada cliente novo (gera uma pasta separada em dist\, com seu
# proprio banco/login/AUTH_SECRET - nenhum cliente compartilha dados com
# outro). As chaves de API (OpenRouter, Geoapify, Meta) sao copiadas do seu
# .env.local atual - o mesmo conjunto de chaves e reaproveitado em todos os
# pacotes gerados, entao cada pacote gerado carrega essas chaves em texto
# puro dentro da pasta do cliente.

param(
    [Parameter(Mandatory = $true)][string]$ClienteNome,
    # Modo 1 (conta nova): informe AdminNome + AdminEmail + AdminSenha - cria
    # um usuario novo no banco do cliente.
    [string]$AdminNome,
    [string]$AdminEmail,
    [string]$AdminSenha,
    # Modo 2 (conta ja existente): informe so ExportarEmailExistente - copia
    # esse usuario (com a senha que ele ja tem) do banco de origem configurado
    # no .env.local atual (TURSO_DATABASE_URL) para o banco local isolado do
    # cliente. Use quando o cliente ja tem login/senha criados.
    [string]$ExportarEmailExistente,
    [string]$NodeMajor = '22',
    [string]$MaxDmsPerDay = '5',
    [switch]$PularBuild
)

$ErrorActionPreference = 'Stop'

# Roda um comando nativo (npm/npx) sem deixar o PowerShell 5.1 transformar
# uma linha benigna de stderr (ex.: aviso de depreciacao do Next.js) num erro
# fatal so por causa do $ErrorActionPreference = 'Stop' global. A checagem
# real de sucesso continua sendo $LASTEXITCODE, feita pelo chamador logo
# depois - aqui so evita abortar o script inteiro por um warning inofensivo.
function Invoke-NativeTolerant {
    param([scriptblock]$Comando)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Comando } finally { $ErrorActionPreference = $prevEap }
}

$modoNovaConta = [bool]$AdminEmail
if ($modoNovaConta -and $ExportarEmailExistente) {
    throw 'Use AdminNome/AdminEmail/AdminSenha OU ExportarEmailExistente, nao os dois.'
}
if (-not $modoNovaConta -and -not $ExportarEmailExistente) {
    throw 'Informe AdminNome+AdminEmail+AdminSenha (conta nova) OU ExportarEmailExistente (conta ja existente).'
}
if ($modoNovaConta -and (-not $AdminNome -or -not $AdminSenha)) {
    throw 'No modo de conta nova, AdminNome, AdminEmail e AdminSenha sao todos obrigatorios.'
}
if ($modoNovaConta -and $AdminSenha.Length -lt 12) {
    throw 'AdminSenha precisa ter pelo menos 12 caracteres (mesma regra do bootstrap-admin).'
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

$pastaSegura = ($ClienteNome -replace '[^a-zA-Z0-9 _-]', '').Trim()
if (-not $pastaSegura) { throw 'ClienteNome invalido (use letras, numeros, espaco, - ou _).' }

$DistDir = Join-Path $ProjectRoot 'dist'
$OutDir = Join-Path $DistDir $pastaSegura
$NodeCacheDir = Join-Path $ProjectRoot 'scripts\.node-cache'

Write-Host "==> Preparando instalador para: $pastaSegura" -ForegroundColor Cyan

if (Test-Path $OutDir) {
    Write-Host "Pasta '$OutDir' ja existe - apagando pra gerar do zero..."
    Remove-Item $OutDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# --- 1) Build de producao ---------------------------------------------------
if (-not $PularBuild) {
    Write-Host "==> Rodando build de producao (npm run build)..." -ForegroundColor Cyan
    Invoke-NativeTolerant { npm run build }
    if ($LASTEXITCODE -ne 0) { throw 'Build falhou - corrija os erros acima antes de gerar o instalador.' }
} else {
    Write-Host "==> Pulando build (-PularBuild) - usando .next\standalone existente." -ForegroundColor Yellow
}

if (-not (Test-Path (Join-Path $ProjectRoot '.next\standalone\server.js'))) {
    throw '.next\standalone\server.js nao encontrado. Rode sem -PularBuild pra gerar o build primeiro.'
}

# --- 2) Copiar standalone + estaticos + publicos ----------------------------
Write-Host "==> Copiando build standalone..." -ForegroundColor Cyan
Copy-Item -Path (Join-Path $ProjectRoot '.next\standalone\*') -Destination $OutDir -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $OutDir '.next') -Force | Out-Null
Copy-Item -Path (Join-Path $ProjectRoot '.next\static') -Destination (Join-Path $OutDir '.next\static') -Recurse -Force
Copy-Item -Path (Join-Path $ProjectRoot 'public') -Destination (Join-Path $OutDir 'public') -Recurse -Force

# --- 3) Node.js portatil (baixado uma vez, cacheado localmente) ------------
$NodeRuntimeDir = Join-Path $OutDir 'node-runtime'
New-Item -ItemType Directory -Path $NodeRuntimeDir -Force | Out-Null
$cachedNodeExe = Join-Path $NodeCacheDir 'node.exe'

if (-not (Test-Path $cachedNodeExe)) {
    Write-Host "==> Baixando Node.js portatil (v$NodeMajor LTS) - so acontece uma vez, fica em cache..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $NodeCacheDir -Force | Out-Null
    $shaUrl = "https://nodejs.org/dist/latest-v$NodeMajor.x/SHASUMS256.txt"
    $shaContent = (Invoke-WebRequest -Uri $shaUrl -UseBasicParsing -TimeoutSec 30).Content
    $zipLine = ($shaContent -split "`r?`n") | Where-Object { $_ -match 'win-x64\.zip$' } | Select-Object -First 1
    if (-not $zipLine) { throw 'Nao foi possivel descobrir a versao do Node.js pra baixar (verifique a internet).' }
    $zipName = ($zipLine -split '\s+')[-1]
    $zipUrl = "https://nodejs.org/dist/latest-v$NodeMajor.x/$zipName"
    $zipPath = Join-Path $NodeCacheDir $zipName

    Write-Host "    Baixando $zipUrl ..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 300

    $extractDir = Join-Path $NodeCacheDir 'extract'
    if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    $extractedFolder = Get-ChildItem $extractDir -Directory | Select-Object -First 1
    Copy-Item -Path (Join-Path $extractedFolder.FullName 'node.exe') -Destination $cachedNodeExe -Force
    Remove-Item $extractDir -Recurse -Force
    Remove-Item $zipPath -Force
    Write-Host "    Node.js portatil salvo em cache: $cachedNodeExe"
}
Copy-Item -Path $cachedNodeExe -Destination (Join-Path $NodeRuntimeDir 'node.exe') -Force

# --- 4) Atalhos do cliente (.bat / .ps1) ------------------------------------
Write-Host "==> Copiando atalhos do cliente..." -ForegroundColor Cyan
Copy-Item -Path (Join-Path $ProjectRoot 'scripts\installer-template\*') -Destination $OutDir -Recurse -Force

# --- 5) .env.local especifico deste cliente --------------------------------
Write-Host "==> Gerando configuracao (.env.local) para este cliente..." -ForegroundColor Cyan
$devEnvPath = Join-Path $ProjectRoot '.env.local'
if (-not (Test-Path $devEnvPath)) {
    throw '.env.local nao encontrado na raiz do projeto - configure as chaves de API (OpenRouter, Geoapify etc.) antes de gerar um instalador.'
}
$envLines = @(Get-Content $devEnvPath)

function Set-EnvLine {
    param([string[]]$Lines, [string]$Key, [string]$Value)
    $escaped = [regex]::Escape($Key)
    $found = $false
    $result = foreach ($line in $Lines) {
        if ($line -match "^\s*$escaped\s*=") {
            $found = $true
            "$Key=$Value"
        } else {
            $line
        }
    }
    if (-not $found) { $result += "$Key=$Value" }
    return $result
}

function Get-EnvValue {
    param([string[]]$Lines, [string]$Key)
    $escaped = [regex]::Escape($Key)
    $line = $Lines | Where-Object { $_ -match "^\s*$escaped\s*=" } | Select-Object -First 1
    if (-not $line) { return '' }
    return ($line -replace "^\s*$escaped\s*=", '').Trim().Trim('"')
}

# Precisa ser lido ANTES de zerar TURSO_DATABASE_URL/TURSO_AUTH_TOKEN mais
# abaixo - e o banco de ONDE a conta existente sera copiada (modo exportar).
$sourceTursoUrl = Get-EnvValue $envLines 'TURSO_DATABASE_URL'
$sourceTursoToken = Get-EnvValue $envLines 'TURSO_AUTH_TOKEN'

$rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::new()
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$authSecret = [Convert]::ToBase64String($bytes)

$envLines = Set-EnvLine $envLines 'AUTH_SECRET' $authSecret
if ($modoNovaConta) {
    $envLines = Set-EnvLine $envLines 'SUPER_ADMIN_NAME' "`"$AdminNome`""
    $envLines = Set-EnvLine $envLines 'SUPER_ADMIN_EMAIL' "`"$AdminEmail`""
    $envLines = Set-EnvLine $envLines 'SUPER_ADMIN_PASSWORD' "`"$AdminSenha`""
} else {
    # Modo "exportar conta existente": SUPER_ADMIN_* nunca e usado (o
    # bootstrap-admin nao roda), mas o seu .env.local de dev pode ter esses
    # campos preenchidos com SUAS proprias credenciais - nao deixar isso
    # vazar em texto puro pra dentro do pacote do cliente.
    $envLines = Set-EnvLine $envLines 'SUPER_ADMIN_NAME' ''
    $envLines = Set-EnvLine $envLines 'SUPER_ADMIN_EMAIL' ''
    $envLines = Set-EnvLine $envLines 'SUPER_ADMIN_PASSWORD' ''
}
$envLines = Set-EnvLine $envLines 'MAX_FIRST_DMS_PER_DAY' $MaxDmsPerDay
$envLines = Set-EnvLine $envLines 'TURSO_DATABASE_URL' ''
$envLines = Set-EnvLine $envLines 'TURSO_AUTH_TOKEN' ''
$envLines = Set-EnvLine $envLines 'DATABASE_URL' ''
$envLines = Set-EnvLine $envLines 'BROWSER_SERVICE_URL' ''
$envLines = Set-EnvLine $envLines 'BROWSER_SERVICE_TOKEN' ''
$envLines = Set-EnvLine $envLines 'CHROME_CDP_URL' 'http://localhost:9222'
$envLines = Set-EnvLine $envLines 'CHROME_USER_DATA_DIR' ''
$envLines = Set-EnvLine $envLines 'PROSPECTION_DRY_RUN' 'true'
# Credenciais da Meta Graph API sao atreladas a UMA conta/app especifico (o
# seu, de dev) - nao fazem sentido pro Instagram do cliente, e vazariam seu
# access token real dentro do pacote se nao forem zeradas aqui. Este
# instalador usa o fluxo via Chrome/CDP, nao a Graph API.
$envLines = Set-EnvLine $envLines 'META_ACCESS_TOKEN' ''
$envLines = Set-EnvLine $envLines 'INSTAGRAM_ACCOUNT_ID' ''
$envLines = Set-EnvLine $envLines 'META_WEBHOOK_VERIFY_TOKEN' ''
$envLines = Set-EnvLine $envLines 'META_APP_SECRET' ''

$clientEnvPath = Join-Path $OutDir '.env.local'
Set-Content -Path $clientEnvPath -Value $envLines -Encoding utf8
Write-Host "    PROSPECTION_DRY_RUN=true por padrao (modo de teste - nao envia DM real). Mude pra false no .env.local do pacote quando o cliente estiver pronto pra enviar de verdade." -ForegroundColor Yellow

# --- 6) Banco do cliente: migrado + login pronto, AQUI, na sua maquina -----
Push-Location $OutDir
try {
    if ($modoNovaConta) {
        Write-Host "==> Preparando banco de dados do cliente (migracoes + usuario admin novo)..." -ForegroundColor Cyan
        $env:DATABASE_URL = 'file:sqlite.db'
        $env:TURSO_DATABASE_URL = ''
        $env:SUPER_ADMIN_NAME = $AdminNome
        $env:SUPER_ADMIN_EMAIL = $AdminEmail
        $env:SUPER_ADMIN_PASSWORD = $AdminSenha

        Invoke-NativeTolerant { npx tsx (Join-Path $ProjectRoot 'src\db\migrate.ts') }
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao migrar o banco do cliente.' }

        Invoke-NativeTolerant { npx tsx (Join-Path $ProjectRoot 'src\db\bootstrap-admin.ts') }
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o usuario admin do cliente.' }

        Remove-Item Env:\SUPER_ADMIN_NAME, Env:\SUPER_ADMIN_EMAIL, Env:\SUPER_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    } else {
        Write-Host "==> Preparando banco de dados do cliente (migracoes + exportando conta existente '$ExportarEmailExistente')..." -ForegroundColor Cyan
        if (-not $sourceTursoUrl) {
            throw "TURSO_DATABASE_URL nao encontrada no seu .env.local - nao ha de onde exportar a conta '$ExportarEmailExistente'."
        }
        $env:DATABASE_URL = 'file:sqlite.db'
        $env:TURSO_DATABASE_URL = ''
        $env:SOURCE_DATABASE_URL = $sourceTursoUrl
        $env:SOURCE_TURSO_AUTH_TOKEN = $sourceTursoToken
        $env:TARGET_DB_PATH = 'file:sqlite.db'
        $env:EXPORT_USER_EMAIL = $ExportarEmailExistente

        Invoke-NativeTolerant { npx tsx (Join-Path $ProjectRoot 'scripts\export-user-to-sqlite.ts') }
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao exportar a conta existente pro banco do cliente.' }

        Remove-Item Env:\SOURCE_DATABASE_URL, Env:\SOURCE_TURSO_AUTH_TOKEN, Env:\TARGET_DB_PATH, Env:\EXPORT_USER_EMAIL -ErrorAction SilentlyContinue
    }
} finally {
    Pop-Location
    Remove-Item Env:\DATABASE_URL, Env:\TURSO_DATABASE_URL -ErrorAction SilentlyContinue
}

# --- 7) Zip final ------------------------------------------------------------
Write-Host "==> Compactando pacote final..." -ForegroundColor Cyan
$zipPath = Join-Path $DistDir "$pastaSegura.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $OutDir '*') -DestinationPath $zipPath -Force

Write-Host ""
Write-Host "==> Pronto!" -ForegroundColor Green
Write-Host "Pasta: $OutDir"
Write-Host "Zip:   $zipPath"
Write-Host ""
Write-Host "Envie o .zip pro cliente. Ele deve:"
Write-Host "  1. Extrair em qualquer pasta (ex.: Area de Trabalho) - a pasta inteira, sem tirar nada de dentro."
Write-Host "  2. Dar duplo-clique em 'Iniciar CRM-1.bat'."
Write-Host "  3. Na primeira vez, fazer login no Instagram na janela do Chrome que vai abrir."
Write-Host ""
if ($modoNovaConta) {
    Write-Host "Login do cliente no CRM: $AdminEmail (senha definida agora)"
} else {
    Write-Host "Login do cliente no CRM: $ExportarEmailExistente (mesma senha que ja usava)"
}
