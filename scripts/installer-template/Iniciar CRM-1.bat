@echo off
REM ============================================================
REM  Iniciar CRM - atalho de um clique (uso diario)
REM  Nao mova este arquivo pra fora desta pasta - ele precisa dos
REM  outros arquivos ao lado (node-runtime, server.js, etc.).
REM  Na PRIMEIRA vez, so dar duplo-clique aqui mesmo (dentro da
REM  pasta). Isso ja cria sozinho, na Area de Trabalho, um atalho
REM  "Iniciar CRM" com icone proprio - use esse depois, no dia a dia.
REM
REM  Repassa na hora pro launcher oculto (Iniciar CRM.vbs), que sobe
REM  o servidor e o Chrome sem nenhuma janela de console visivel -
REM  esta janela preta do .bat fecha sozinha quase na hora (só existe
REM  por um instante porque o Windows sempre abre uma ao dar duplo-
REM  clique num .bat; a partir do atalho "Iniciar CRM" da Area de
REM  Trabalho, criado logo no primeiro uso, nem essa janela aparece).
REM  Erros (Chrome ausente, servidor que nao sobe etc.) continuam
REM  aparecendo normalmente em caixa de aviso - isso e feito pelo
REM  proprio Iniciar CRM.ps1, nao depende desta janela.
REM ============================================================

start "" wscript.exe "%~dp0Iniciar CRM.vbs"
exit
