' ===========================================================================
'  VNTG deploy watcher -- silent launcher.  ASCII ONLY.
'
'  !! DO NOT PUT KOREAN (OR ANY NON-ASCII) IN THIS FILE !!
'  Same reason as deploy-watch.cmd: Windows Script Host reads a .vbs as the
'  OEM codepage unless it is UTF-16, so a UTF-8 file decodes into garbage.
'
'  WHY THIS EXISTS  (2026-11-20)
'
'  Vantage: "cmd creating keeps coming to the front and makes the mini PC
'  awkward to use.  Can it be a quiet update, in the background?"
'
'  The watcher is a 1-minute scheduled task that polls 11 times, 5 seconds
'  apart, so its console window is on screen for nearly every second of every
'  minute -- and it prints NOTHING.  Echo is off and every command inside is
'  redirected to the log, so that black rectangle carries no information at
'  all.  It was pure cost.
'
'  wscript.exe has no console of its own, so the scheduled task can point here
'  instead, and we start the .cmd with window style 0.
'
'  WAIT FOR IT -- the third argument of .Run must stay True.  While we wait the
'  scheduled task still counts as running, so Task Scheduler's "do not start a
'  new instance" rule keeps two watchers from overlapping.  Returning at once
'  would end the task instance immediately and quietly break that guard: every
'  minute would stack another watcher on top of the last.
'
'  MEASURED BEFORE SHIPPING (main PC, 2026-11-20):
'    - task action = the .cmd directly  -> a visible WindowsTerminal window
'    - task action = wscript + this .vbs -> no new visible window
'    - the job ran in both cases (tick file grew)
' ===========================================================================
Option Explicit

Dim fso, sh, target, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

target = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "deploy-watch.cmd")

' Missing watcher: say so in the drop folder rather than failing in silence.
' A dead watcher means deploys stop landing, and nothing else would report it.
If Not fso.FileExists(target) Then
  On Error Resume Next
  fso.CreateTextFile("C:\vntg-deploy\watch.error", True).WriteLine Now & " missing " & target
  On Error GoTo 0
  WScript.Quit 1
End If

' 0 = no window, True = wait for it to finish.
rc = sh.Run("""" & target & """", 0, True)
WScript.Quit rc
