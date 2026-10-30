# Iniciar CRM - logica do atalho de um clique (uso diario) NO PC DO CLIENTE.
# Chamado pelo "Iniciar CRM-1.bat" - nao precisa ser executado direto.
#
# Este arquivo faz parte do PACOTE gerado por
# scripts/prepare-client-installer.ps1 - ele espera encontrar, na mesma
# pasta onde ele mesmo esta (via $PSScriptRoot), um Node.js portatil
# (node-runtime\node.exe) e o build pronto do CRM (server.js). O cliente
# nunca precisa instalar Node, npm ou rodar nenhum comando - só dar
# duplo-clique no "Iniciar CRM-1.bat".
#
# O que este script faz, na ordem:
#  1. Confirma o Chrome instalado (mesmo em instalacoes sem admin); se nao
#     encontrar, baixa e instala sozinho (sem precisar de admin).
#  2. Sobe o servidor do CRM (Node portatil embutido) E abre o Chrome com o
#     CDP ligado AO MESMO TEMPO (em paralelo, nao um depois do outro - sao
#     dois processos independentes, um nao precisa esperar o outro pra
#     comecar a subir). Antes essas duas esperas eram sequenciais (server
#     pronto -> so entao abre o Chrome -> so entao espera o Chrome), o que
#     somava os dois tempos de boot (~15s na pratica); agora os dois sobem
#     juntos e o script so espera o MAIOR dos dois, nao a soma.
#  3. Abre (ou reaproveita) UMA UNICA janela do Chrome com o CDP ligado
#     (porta de automacao) contendo DUAS abas: a tela do CRM e o Instagram
#     (necessario para a automacao usar a sessao/cookies desse perfil).
#     Se essa janela ja estiver aberta, so garante que as duas abas existem
#     (sem duplicar) em vez de abrir o CRM no navegador padrao separado.
#  4. Se a janela nao existir, verifica se ha um Chrome aberto no MESMO
#     perfil dedicado mas SEM o CDP respondendo (travado/zumbi - ex.: ficou
#     "meio vivo" ao fechar a ultima aba). Fecha essas instancias (nunca
#     outras janelas do Chrome do cliente) e abre de novo do jeito certo.

$ErrorActionPreference = 'SilentlyContinue'

$PackageRoot = $PSScriptRoot
$NodeExe = Join-Path $PackageRoot 'node-runtime\node.exe'
$ServerJs = Join-Path $PackageRoot 'server.js'
$LogFile = Join-Path $PackageRoot 'crm-server.log'
$ChromeProfile = Join-Path $PackageRoot 'ChromeCRM'
$CdpPort = 9222
$AppUrl = 'http://localhost:3000'

function Show-Aviso($mensagem, $titulo) {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    # MessageBox sem "dono" pode abrir atras de outras janelas e o cliente
    # nunca ve o aviso (parece que o sistema travou). Um form invisivel e
    # TopMost como dono forca a caixa pra frente de tudo.
    $dono = New-Object System.Windows.Forms.Form
    $dono.TopMost = $true
    $dono.ShowInTaskbar = $false
    [void]$dono.Handle # forca a criacao do handle sem exibir o form
    [System.Windows.Forms.MessageBox]::Show($dono, $mensagem, $titulo, 'OK', 'Warning') | Out-Null
    $dono.Dispose()
}

# Cria (ou atualiza, se a pasta tiver sido movida) um atalho na Area de
# Trabalho com um icone de verdade, em vez do icone generico de arquivo .bat
# (que parece script suspeito pra quem nao e da area). Reaplicado a cada
# execucao - barato, e sempre corrige o caminho se o cliente mover a pasta.
function Set-DesktopShortcut {
    param([string]$NomeAtalho, [string]$AlvoExe, [string]$Argumentos, [string]$IconLocation)
    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        $lnkPath = Join-Path $desktop "$NomeAtalho.lnk"
        $wsh = New-Object -ComObject WScript.Shell
        $shortcut = $wsh.CreateShortcut($lnkPath)
        $shortcut.TargetPath = $AlvoExe
        if ($Argumentos) { $shortcut.Arguments = $Argumentos }
        $shortcut.WorkingDirectory = $PackageRoot
        if ($IconLocation) { $shortcut.IconLocation = $IconLocation }
        $shortcut.Save()
    } catch {
        # Nao trava o sistema por causa disso - o atalho e so cosmetico.
    }
}

function Find-Chrome {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($path in $candidates) {
        if ($path -and (Test-Path $path)) { return $path }
    }
    try {
        $regPath = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction Stop).'(default)'
        if ($regPath -and (Test-Path $regPath)) { return $regPath }
    } catch {}
    return $null
}

function Install-Chrome {
    $installerPath = Join-Path $env:TEMP 'chrome_installer.exe'
    try {
        Invoke-WebRequest -Uri 'https://dl.google.com/chrome/install/latest/chrome_installer.exe' -OutFile $installerPath -UseBasicParsing -TimeoutSec 120
        Start-Process -FilePath $installerPath -ArgumentList '/silent', '/install' -Wait
    } catch {
        return $null
    } finally {
        Remove-Item $installerPath -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    return (Find-Chrome)
}

function Test-CdpReady {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/version" -TimeoutSec 2 -UseBasicParsing
        return $resp.StatusCode -eq 200
    } catch { return $false }
}

function Test-ServerReady {
    try {
        # Timeout maior que o do CDP: com o Chrome (varios processos) e
        # outros programas abertos ao mesmo tempo, 2s as vezes nao bastava
        # e dava falso-negativo, fazendo o script tentar subir um SEGUNDO
        # Node na mesma porta (que morre na hora com EADDRINUSE).
        $resp = Invoke-WebRequest -Uri $AppUrl -TimeoutSec 5 -UseBasicParsing
        return $resp.StatusCode -lt 500
    } catch { return $false }
}

function Get-ServerProcess {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$ServerJs*" }
}

# Trava de instancia unica: se o cliente clicar no icone duas vezes seguidas
# (ou o Explorer disparar o atalho de novo antes do primeiro terminar), a
# SEGUNDA execucao entrava na mesma logica de "matar Chrome sem CDP e abrir
# de novo" ao mesmo tempo que a primeira - uma matava o Chrome/Node que a
# outra tinha acabado de subir, e as duas ficavam esperando uma prontidao
# que nunca chegava. Agora a segunda so espera a primeira terminar (o
# trabalho pesado - subir Node e Chrome - so acontece uma vez).
$mutex = New-Object System.Threading.Mutex($false, 'Global\SirrusCRMLauncher')
$temATrava = $mutex.WaitOne([TimeSpan]::FromMinutes(3))

try {
  if (-not $temATrava) {
    # Outra execucao ja estava rodando ha mais de 3 minutos - incomum
    # (deveria ter terminado bem antes disso). Nao mexe em nada pra nao
    # brigar com ela; so confere se o sistema ja esta de pe.
    if ((Test-ServerReady) -and (Test-CdpReady)) {
        Start-Process $AppUrl
    } else {
        Show-Aviso 'Outra execucao do CRM ja estava iniciando ha varios minutos e nao terminou. Feche todas as janelas do Chrome e do CRM e clique no atalho de novo.' 'CRM - outra execucao em andamento'
    }
    exit 0
  }
    # --- 0) Node/servidor embutidos existem? (protege contra pasta incompleta) -
    if (-not (Test-Path $NodeExe) -or -not (Test-Path $ServerJs)) {
        Show-Aviso 'Arquivos do sistema incompletos nesta pasta (falta node-runtime ou server.js). Copie a pasta inteira de novo, sem deixar nenhum arquivo pra tras, e tente de novo.' 'CRM - instalacao incompleta'
        exit 1
    }

# Atalho com icone proprio na Area de Trabalho - a partir de agora, o
# cliente pode usar esse em vez do .bat direto (que so tem o icone generico
# de script). Aponta pro launcher .vbs (via wscript.exe), que abre o
# PowerShell 100% oculto - nao passa mais pelo .bat, entao nenhuma janela de
# console aparece (nem por um instante) a partir do segundo clique em
# diante. Feito cedo, antes de qualquer outra coisa, pra existir mesmo se
# algo mais abaixo falhar.
$crmIcon = Join-Path $PackageRoot 'assets\crm.ico'
$wscriptExe = Join-Path $env:WINDIR 'System32\wscript.exe'
$vbsLauncher = Join-Path $PackageRoot 'Iniciar CRM.vbs'
Set-DesktopShortcut -NomeAtalho 'Iniciar CRM' -AlvoExe $wscriptExe -Argumentos "`"$vbsLauncher`"" -IconLocation "$crmIcon,0"

# --- 1) Chrome instalado? ------------------------------------------------
$chromeExe = Find-Chrome
if (-not $chromeExe) {
    Show-Aviso 'O Google Chrome nao foi encontrado neste computador. Vou instalar agora - isso pode levar 1 a 2 minutos. Clique em OK e aguarde.' 'CRM - instalando o Chrome'
    $chromeExe = Install-Chrome
    if (-not $chromeExe) {
        Show-Aviso 'Nao foi possivel instalar o Chrome automaticamente (verifique sua conexao com a internet). Instale manualmente em google.com/chrome e clique no atalho de novo.' 'CRM - falha ao instalar o Chrome'
        exit 1
    }
}

# Atalho de login do Instagram com o icone real do Chrome (deixa claro que
# so abre o navegador - nada escondido).
$loginBat = Join-Path $PackageRoot 'Login Instagram (uma vez so).bat'
Set-DesktopShortcut -NomeAtalho 'Login Instagram (uma vez so)' -AlvoExe $loginBat -IconLocation "$chromeExe,0"

# --- 2) Dispara o Node (servidor) e o Chrome (CDP) JUNTOS, sem um esperar
# o outro pra COMECAR a subir - so esperamos os dois ficarem prontos depois.
$env:CHROME_USER_DATA_DIR = $ChromeProfile
$env:CHROME_CDP_URL = "http://127.0.0.1:$CdpPort"

$serverJaEstavaPronto = Test-ServerReady
if ($serverJaEstavaPronto) {
    Write-Host 'Servidor do CRM ja esta rodando.'
} else {
    # So sobe um Node novo se realmente nao ha nenhum processo nosso rodando
    # ainda - senao um Test-ServerReady lento/falso-negativo (maquina
    # ocupada) faria subir um SEGUNDO node.exe na mesma porta, que crasha na
    # hora com EADDRINUSE e so atrasa tudo.
    if (Get-ServerProcess) {
        Write-Host 'Servidor do CRM ja esta subindo (processo existente) - so aguardando...'
    } else {
        Start-Process -FilePath $NodeExe -ArgumentList "`"$ServerJs`"" -WorkingDirectory $PackageRoot -WindowStyle Hidden `
            -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err"
    }
}

$cdpJaEstavaPronto = Test-CdpReady
$chromeAbertoAgora = $false
if (-not $cdpJaEstavaPronto) {
    # Chegamos aqui porque o CDP NAO esta respondendo - entao qualquer
    # chrome.exe deste perfil que ainda exista (mesmo com a flag de CDP no
    # command line) e um processo travado/zumbi (ex.: ficou "meio vivo" por
    # um instante ao fechar a ultima aba, segurando o lock do perfil). Se
    # deixarmos ele vivo, o chrome.exe novo so repassa a URL pra ele via
    # singleton e NEM ABRE com --remote-debugging-port de verdade - por
    # isso antes so matava quem nao tinha a flag, e a porta nunca respondia.
    $conflitantes = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like "*$ChromeProfile*"
        }
    if ($conflitantes) {
        foreach ($proc in $conflitantes) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
        # Espera de verdade os processos sumirem (o lock do perfil so e
        # liberado quando o processo termina de fato) em vez de um sleep
        # fixo que pode nao ser suficiente.
        for ($i = 0; $i -lt 40; $i++) {
            $aindaVivos = $conflitantes | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
            if (-not $aindaVivos) { break }
            Start-Sleep -Milliseconds 250
        }
    }

    # As abas (CRM + Instagram) ja nascem como argumento aqui: nao precisa
    # esperar o servidor estar pronto pra ISSO - o Chrome so vai renderizar
    # a pagina do CRM quando o servidor responder, e ate la fica com o
    # spinner de carregamento normal da aba (equivalente ao que aconteceria
    # se abrissemos a aba depois, so que sem esperar sequencialmente aqui).
    Start-Process -FilePath $chromeExe -ArgumentList @(
        "--remote-debugging-port=$CdpPort",
        "--user-data-dir=$ChromeProfile",
        $AppUrl,
        'https://www.instagram.com'
    )
    $chromeAbertoAgora = $true
}

# --- 3) Espera os DOIS ficarem prontos - EM PARALELO, nao um depois do
# outro. Antes: ate 30s esperando so o servidor, DEPOIS ate 45s esperando so
# o Chrome (podia somar ~15s+ no caso comum de maquina fria). Agora: um unico
# loop que confere os dois a cada 500ms e sai assim que ambos responderem -
# o tempo total passa a ser o MAIOR dos dois, nao a soma.
$serverPronto = $serverJaEstavaPronto
$cdpPronto = $cdpJaEstavaPronto
# 240 x 500ms = 120s de teto. Antes eram 45s - bastava um PC mais lento, uma
# maquina sob carga pesada, ou (comum na PRIMEIRA execucao depois de extrair
# o pacote) o antivirus escaneando o node.exe/chrome.exe recem-chegados, pra
# o Chrome legitimamente demorar mais que isso e disparar o aviso "automacao
# nao respondeu" mesmo quando o sistema ia terminar de subir normalmente
# poucos segundos depois. 120s ainda tem teto (nao trava pra sempre) mas da
# folga de sobra pro pior caso real de primeira execucao.
$maxTentativas = 240
for ($i = 0; $i -lt $maxTentativas; $i++) {
    if ($serverPronto -and $cdpPronto) { break }
    Start-Sleep -Milliseconds 500
    if (-not $serverPronto) { $serverPronto = Test-ServerReady }
    if (-not $cdpPronto) { $cdpPronto = Test-CdpReady }
}

if (-not $serverPronto) {
    Show-Aviso "O sistema demorou demais para iniciar. Veja o arquivo crm-server.log nesta pasta ou peca ajuda ao suporte." 'CRM - demorou para iniciar'
}
if (-not $cdpPronto) {
    Show-Aviso "O Chrome abriu, mas a automacao (porta $CdpPort) nao respondeu a tempo. Feche TODAS as janelas do Chrome e clique no atalho de novo." 'CRM - automacao nao respondeu'
}

# --- 4) Garante as abas certas na janela do Chrome com CDP ----------------
if ($cdpPronto -and -not $chromeAbertoAgora) {
    # A janela com CDP ja existia de antes (nao foi esta execucao que abriu)
    # - reaproveita abas ja abertas (Instagram e CRM) ou abre as que
    # faltarem, sempre na MESMA janela, em vez de "Start-Process $AppUrl"
    # (que abriria o navegador padrao do Windows numa janela separada).
    Write-Host 'Chrome com automacao ja estava aberto - garantindo as duas abas (Instagram + CRM) nessa mesma janela.'
    try {
        $abas = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 3
        $abaCrm = $abas | Where-Object { $_.url -like "$AppUrl*" } | Select-Object -First 1
        if ($abaCrm) {
            Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/activate/$($abaCrm.id)" -UseBasicParsing -TimeoutSec 3 | Out-Null
        } else {
            Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/new?$AppUrl" -UseBasicParsing -TimeoutSec 3 | Out-Null
        }

        $abaInsta = $abas | Where-Object { $_.url -like '*instagram.com*' } | Select-Object -First 1
        if (-not $abaInsta) {
            Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/new?https://www.instagram.com" -UseBasicParsing -TimeoutSec 3 | Out-Null
        }
    } catch {
        Start-Process $AppUrl
    }
} elseif (-not $cdpPronto) {
    # Chrome nem respondeu - sem CDP pra ativar abas, abre no navegador
    # padrao mesmo (pelo menos o cliente ve a tela do CRM, mesmo que a
    # automacao do Instagram fique indisponivel ate ele reabrir o atalho).
    Start-Process $AppUrl
}
# Se $chromeAbertoAgora e $cdpPronto: nao faz nada aqui - as abas ja nasceram
# certas direto no Start-Process do passo 2, nao precisa reabrir nada.
} finally {
    if ($temATrava) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
