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
cd /d "%~dp0"

set "DROP=C:\vntg-deploy"
if not exist "%DROP%" mkdir "%DROP%"

set /a N=0
set /a DEAD=0
:loop
REM Heartbeat, so "is the watcher running?" can be answered from the share.
echo %date% %time%> "%DROP%\watch.alive"

if exist "%DROP%\deploy.flag" if not exist "%DROP%\deploy.lock" (
  echo %date% %time%> "%DROP%\deploy.lock"
  del /q "%DROP%\deploy.flag"
  call "%~dp0deploy.cmd"
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
