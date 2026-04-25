Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = projectDir & "\node_modules\electron\dist\electron.exe"
mainJs = projectDir & "\electron\main.js"

shell.CurrentDirectory = projectDir

If Not fso.FileExists(electronExe) Then
  MsgBox "Electron is not installed yet. Run 'npm install' once in this project folder first.", vbExclamation, "SoCaRi Market Bot"
  WScript.Quit 1
End If

If Not fso.FileExists(mainJs) Then
  MsgBox "Could not find electron\main.js. Please verify your project files.", vbExclamation, "SoCaRi Market Bot"
  WScript.Quit 1
End If

' Launches Electron directly as a GUI app (hidden script host, no cmd window).
shell.Run Chr(34) & electronExe & Chr(34) & " " & Chr(34) & mainJs & Chr(34), 0, False
