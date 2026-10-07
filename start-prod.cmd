@echo off
REM ===========================================================================
REM  VNTG HTS production launcher.  ASCII ONLY -- notes in start-prod.md.
REM
REM  !! DO NOT PUT KOREAN (OR ANY NON-ASCII) IN THIS FILE !!
REM  cmd.exe reads .cmd as the OEM codepage (CP949).  A UTF-8 file decodes into
REM  garbage that can contain '&', which ends the REM and runs the rest as a
REM  command.  That broke the watcher console on 2026-10-07.
REM
REM  One server serves both the API and the web UI.  Registered in Task
REM  Scheduler as "VNTG HTS", trigger "at system startup".
REM
REM  stdout+stderr go to C:\vntg-deploy\server.log.  Without this redirect a V8
REM  "FATAL ERROR: ... heap out of memory" leaves no trace at all -- it is not
REM  catchable from JS and only ever reaches stderr.
REM
REM  Restarting is NOT done here.  deploy-watch.cmd owns that, so the two never
REM  fight over the port.
REM ===========================================================================
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0server"

set "DROP=C:\vntg-deploy"
if not exist "%DROP%" set "DROP=%~dp0"
set "LOG=%DROP%\server.log"

REM Roll the log once it passes 20MB; keep two generations.
for %%A in ("%LOG%") do if %%~zA GTR 20000000 (
  del /q "%LOG%.1" 2>nul
  move /y "%LOG%" "%LOG%.1" >nul 2>&1
)

REM Lets the server record "I was started by this script" in health.json.
set "VNTG_LAUNCHER=start-prod"

REM Raise the heap ceiling.  Node defaults to 2,240MB on this box, and the
REM server loads dailyCloses.json (84MB) and signalSamples.json (38MB) whole --
REM 931MB of heap 32 seconds after boot.  Intraday caches then hit the ceiling
REM and the process died of OOM every ~10 minutes on the night of 10/6.
REM
REM 3,584 -> 6,144 on 2026-10-07 night.  It died twice more (exit 134 at 22:13
REM and 22:20) with heap peaking at 3,100MB while the box still had 8,202MB of
REM free RAM.  One stock page fans out to ~15 routes at once and a board with
REM three chart cards multiplies that, so the peak is baseline + the SUM of
REM whatever happens to be in flight.
REM The server now also caps how many heavy requests run at once and sheds load
REM near the ceiling (see index.ts) -- this number is the safety margin behind
REM that, not the fix.  Not holding whole files in heap is the real cure.
echo.>> "%LOG%"
echo ==== %date% %time% server start ====>> "%LOG%"
REM --expose-gc lets the recovery routine (recovery.ts) run a full GC on demand
REM instead of waiting for V8 to get around to it.  Waiting is what turned a
REM busy minute into a 40-second-per-request crawl.
node --expose-gc --max-old-space-size=6144 dist\index.js >> "%LOG%" 2>&1
echo ==== %date% %time% server exit %errorlevel% ====>> "%LOG%"
