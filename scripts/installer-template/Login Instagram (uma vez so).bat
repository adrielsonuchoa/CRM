@echo off
REM Use este atalho SOMENTE UMA VEZ, para logar no Instagram.
REM Depois de logar, feche esta janela do Chrome e use o
REM "Iniciar CRM-1.bat" normalmente no dia a dia.
REM
REM IMPORTANTE: feche o CRM (se estiver rodando) antes de usar este atalho -
REM os dois nao podem usar o mesmo perfil de Chrome ao mesmo tempo.

set PERFIL_CHROME=%~dp0ChromeCRM

REM "start chrome" (sem caminho fixo) usa o Chrome que o Windows tem
REM registrado, mesmo em instalacoes sem permissao de administrador.
start "" chrome --remote-debugging-port=9222 --user-data-dir="%PERFIL_CHROME%" "https://www.instagram.com"
