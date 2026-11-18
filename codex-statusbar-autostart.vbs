' ============================================================
'  codex-statusbar - windowless daemon starter.
'
'  Runs the injector daemon (node codex-statusbar.mjs) with NO
'  window at all: no console, nothing in the taskbar.
'  Idempotent: if the daemon is already alive (--locked exits 0),
'  this exits immediately.
'
'  Stop the daemon later with:
'      node codex-statusbar.mjs --stop
'
'  Keep this file pure ASCII so the WSH code page never matters.
' ============================================================
Option Explicit

Dim sh, fso, here, rc
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

' Already running? (--locked exits 0 when the daemon is alive)
rc = sh.Run("node """ & here & "\codex-statusbar.mjs"" --locked", 0, True)
If rc = 0 Then WScript.Quit 0

' Hidden console (window style 0) running node; output lands in statusbar.log.
' Fire-and-forget: this process exits immediately, the daemon keeps running.
sh.Run "cmd /c node """ & here & "\codex-statusbar.mjs"" > """ & here & "\statusbar.log"" 2>&1", 0, False
