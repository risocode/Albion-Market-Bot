Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = projectDir
shell.Run Chr(34) & projectDir & "\Start Albion Bot Dashboard.bat" & Chr(34), 0, False
