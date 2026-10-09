@echo off
REM ===========================================================================
REM  VNTG unattended deploy (mini PC only).  ASCII ONLY -- notes in deploy.md.
REM
REM  !! DO NOT PUT KOREAN (OR ANY NON-ASCII) IN THIS FILE !!
REM  cmd.exe reads .cmd files as the OEM codepage (CP949 here), so a UTF-8 file
REM  decodes into garbage, and the garbage can contain a literal '&' which ENDS
REM  the REM and runs whatever follows.  That is what filled the console with
REM  "'xxx' is not recognized..." on 2026-10-07.  This file carried 412 non-ASCII
REM  bytes until 2026-10-10 -- the same loaded gun, simply not yet fired.
REM
REM  Called by deploy-watch.cmd when C:\vntg-deploy\deploy.flag appears.
REM  On failure the service is NOT restarted: running the old build beats
REM  killing a healthy server because the new build is broken.
REM ===========================================================================
setlocal
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\cmd;%PATH%"
cd /d "%~dp0"

set "DROP=C:\vntg-deploy"
set "LOG=%DROP%\deploy.log"
set "ST=%DROP%\deploy.status"
if not exist "%DROP%" mkdir "%DROP%"

echo ==== %date% %time% deploy start ====> "%LOG%"

echo.>> "%LOG%"
echo [1/4] syncing code to origin/master...>> "%LOG%"
REM ---------------------------------------------------------------------------
REM  EXACT MIRROR, not a merge.  'git pull' used to run here, and because this
REM  checkout had drifted from origin it produced a merge commit on every single
REM  deploy.  HEAD then never equalled the pushed commit, so the hash written to
REM  deploy.status could not be compared with the hash in deploy.flag -- the one
REM  check that answers "did MY code actually go up?" was dead.  On 2026-10-09
REM  seven deploys went out that way, flag 589e28b vs HEAD 2360376.
REM
REM  reset --hard is safe here: this machine is a deploy target, nobody edits
REM  code on it, and everything it writes (server/data/*.json and friends) is
REM  gitignored, which reset does not touch.  Anything that WOULD be thrown away
REM  is listed in the log first, so a surprise leaves a trace instead of silence.
REM ---------------------------------------------------------------------------
git fetch --prune origin>> "%LOG%" 2>&1 || goto :fail
echo -- local commits that will be discarded (should be none) -->> "%LOG%"
git log --oneline origin/master..HEAD>> "%LOG%" 2>&1
git reset --hard origin/master>> "%LOG%" 2>&1 || goto :fail

echo.>> "%LOG%"
echo [2/4] building server...>> "%LOG%"
cd server
call npm install --no-audit --no-fund>> "%LOG%" 2>&1 || goto :fail
call npm run build>> "%LOG%" 2>&1 || goto :fail
cd ..

echo.>> "%LOG%"
echo [3/4] building web...>> "%LOG%"
cd web
call npm install --no-audit --no-fund>> "%LOG%" 2>&1 || goto :fail
call npm run build>> "%LOG%" 2>&1 || goto :fail
cd ..

echo.>> "%LOG%"
echo [4/4] restarting service...>> "%LOG%"
schtasks /End /TN "VNTG HTS" >nul 2>&1
schtasks /Run /TN "VNTG HTS" >nul 2>&1

REM Boot takes a while (the 84MB daily-bar file is parsed on the way up).
timeout /t 8 /nobreak >nul
echo.>> "%LOG%"
echo -- /api/health -->> "%LOG%"
curl -s -m 10 http://localhost:4000/api/health>> "%LOG%" 2>&1
echo.>> "%LOG%"

echo ==== %date% %time% done ====>> "%LOG%"

REM ---------------------------------------------------------------------------
REM  SAY WHETHER THE RIGHT COMMIT LANDED  (2026-10-10)
REM
REM  The status file used to carry the deployed hash and nothing else, so the
REM  comparison with the requested hash was left to whoever read it -- and that
REM  reader skipped it, every time, for seven deploys in a row.  A check a human
REM  has to remember to perform is not a check.  The watcher saves the requested
REM  hash as deploy.want; compare it here and write the verdict in words.
REM  No parentheses around the 'set /p': inside a block %WANT% would expand to
REM  its value from before the block, which is empty.
REM ---------------------------------------------------------------------------
set "WANT="
if exist "%DROP%\deploy.want" set /p WANT=<"%DROP%\deploy.want"
for /f %%h in ('git rev-parse --short HEAD') do set "GOT=%%h"
echo OK %date% %time%> "%ST%"
echo %GOT%>> "%ST%"
if not defined WANT (
  echo NOWANT no requested hash recorded>> "%ST%"
) else if /i "%WANT%"=="%GOT%" (
  echo MATCH %GOT%>> "%ST%"
) else (
  echo MISMATCH want=%WANT% head=%GOT%>> "%ST%"
)
if exist "%DROP%\deploy.want" del /q "%DROP%\deploy.want"
exit /b 0

:fail
echo.>> "%LOG%"
echo *** FAILED -- see the messages above. ***>> "%LOG%"
echo ==== %date% %time% failed ====>> "%LOG%"
echo FAIL %date% %time%> "%ST%"
git rev-parse --short HEAD>> "%ST%" 2>&1
exit /b 1
