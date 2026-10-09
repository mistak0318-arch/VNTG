@echo off
REM ===========================================================================
REM  VNTG deploy watcher.  ASCII ONLY -- see deploy-watch.md for the full notes.
REM
REM  !! DO NOT PUT KOREAN (OR ANY NON-ASCII) IN THIS FILE !!
REM  cmd.exe reads .cmd files as the OEM codepage (CP949 here).  A UTF-8 file
REM  therefore decodes into garbage, and the garbage can contain a literal '&'
REM  which ENDS the REM and runs whatever follows as a command.  That is exactly
REM  what happened on 2026-10-07: the console filled with
REM    'xxx' is not recognized as an internal or external command
REM  every single minute.  Keep this file 7-bit ASCII and the question cannot
REM  arise, whichever editor touches it next.
REM
REM  Called every minute by the scheduled task "VNTG DEPLOY WATCH".
REM  One call polls 11 times, 5s apart, so it covers the whole minute.
REM
REM  Two jobs:
REM    1) if deploy.flag exists -> run deploy.cmd
REM    2) if /api/health is silent 6 polls in a row (~60s) -> restart the server
REM
REM  The 60s patience is deliberate.  The server blocks its event loop for
REM  several seconds while parsing the 84MB daily-bar file, and health cannot
REM  answer during that.  A hair trigger killed a healthy server twice
REM  (00:38:23 and 00:39:06 on 2026-10-07) and created a restart loop.
REM ===========================================================================
setlocal

REM ---------------------------------------------------------------------------
REM  RUN FROM A PRIVATE COPY  (2026-10-10)
REM
REM  cmd.exe does not load a batch file; it re-reads the next line from disk by
REM  BYTE OFFSET after every command.  A deploy updates this very file and
REM  deploy.cmd while they are executing, so the offset can land mid-line and
REM  cmd runs a fragment.  It has been a coin flip on every deploy that touched
REM  these two files -- the kind of fault that shows up once and is never
REM  reproduced.  Copy first, run the copy, and the file on disk can change all
REM  it likes.  VNTG_HOME carries the real repo path, because %~dp0 inside the
REM  copy points at %TEMP%.
REM ---------------------------------------------------------------------------
if not "%VNTG_WATCH_RUN%"=="1" (
  set "VNTG_WATCH_RUN=1"
  set "VNTG_HOME=%~dp0"
  copy /y "%~f0" "%TEMP%\vntg-watch-run.cmd" >nul
  call "%TEMP%\vntg-watch-run.cmd"
  exit /b %errorlevel%
)

REM The trailing backslash of %~dp0 would end the quote for cd -- the dot fixes it.
cd /d "%VNTG_HOME%."

set "DROP=C:\vntg-deploy"
if not exist "%DROP%" mkdir "%DROP%"

set /a N=0
set /a DEAD=0
:loop
REM Heartbeat, so "is the watcher running?" can be answered from the share.
echo %date% %time%> "%DROP%\watch.alive"

if exist "%DROP%\deploy.flag" if not exist "%DROP%\deploy.lock" (
  echo %date% %time%> "%DROP%\deploy.lock"
  REM Keep the flag's hash: deploy.cmd compares it with HEAD and says so.
  copy /y "%DROP%\deploy.flag" "%DROP%\deploy.want" >nul
  del /q "%DROP%\deploy.flag"
  REM Same reason as above -- deploy.cmd rewrites itself at its first step.
  copy /y "%VNTG_HOME%deploy.cmd" "%TEMP%\vntg-deploy-run.cmd" >nul
  call "%TEMP%\vntg-deploy-run.cmd"
  del /q "%DROP%\deploy.lock"
  set /a DEAD=0
)

REM ---- server alive? ------------------------------------------------------
REM During a deploy the server is down on purpose, so skip the check.
if exist "%DROP%\deploy.lock" (
  set /a DEAD=0
) else (
  curl -s -f -m 10 -o nul http://localhost:4000/api/health
  if errorlevel 1 (set /a DEAD+=1) else (set /a DEAD=0)
)

if %DEAD% GEQ 6 (
  echo %date% %time% health no-response x%DEAD% - restarting>> "%DROP%\restart.log"
  schtasks /End /TN "VNTG HTS" >nul 2>&1
  timeout /t 2 /nobreak >nul
  schtasks /Run /TN "VNTG HTS" >nul 2>&1
  set /a DEAD=0
  REM Booting takes a while and the big files load after that -- stay quiet 90s.
  timeout /t 90 /nobreak >nul
)

set /a N+=1
if %N% GEQ 11 exit /b 0
timeout /t 5 /nobreak >nul
goto :loop
