' Iniciar CRM.vbs - launcher 100% oculto (sem janela de console) usado pelo
' atalho "Iniciar CRM" da Area de Trabalho, a partir do momento em que ele e
' criado/atualizado por "Iniciar CRM.ps1".
'
' Por que existe: rodar o PowerShell direto (ou via .bat) sempre abre uma
' janela preta, mesmo que feche sozinha rapido. WScript.Shell.Run com o
' parametro de janela "0" nao abre janela nenhuma - nem por um instante.
' O .vbs em si tambem nao tem janela propria (roda via wscript.exe, o host
' "sem interface" do Windows Script Host).
'
' Se algo der errado (Chrome ausente, servidor nao sobe, etc.), o proprio
' "Iniciar CRM.ps1" mostra um aviso em caixa de dialogo normal - isso
' continua funcionando normalmente, so a janela de console que some.

Dim shell, fso, scriptDir, ps1Path, comando

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1Path = scriptDir & "\Iniciar CRM.ps1"

shell.CurrentDirectory = scriptDir

comando = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1Path & """"

' 0 = janela oculta; False = nao espera terminar (o .ps1 cuida de tudo
' sozinho, inclusive avisos de erro em caixa de dialogo).
shell.Run comando, 0, False
