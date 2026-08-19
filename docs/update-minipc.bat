@echo off
REM 미니PC 전용 - 최신 코드를 받아 빌드하고 서비스를 재시작한다.
REM 메인 PC에서 git push 한 뒤 미니PC에서 이 파일을 더블클릭하면 끝.
REM
REM 이 파일은 docs\ 안에 있지만 저장소 뿌리에서 돌아야 한다. 그래서 %~dp0.. 로 올라간다.
REM 예전엔 %~dp0 만 써서 docs 안에서 package.json 을 찾다가 죽었다.
REM
REM 이 파일은 cp949(ANSI 한국어) + CRLF 로 저장한다. UTF-8 로 두면 cmd 가
REM 한글을 깨서 읽고, LF 로 두면 괄호 블록 안의 줄을 잘못 끊는다. 둘 다 겪었다.
REM
REM [0/5] 백업: 데이터 파일은 git 추적에서 뺐으므로 원격에 사본이 없다.
REM       디스크가 죽으면 그대로 사라진다. 그래서 pull 전에 날짜별로 복사해 둔다.
setlocal enabledelayedexpansion
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\cmd;%PATH%"
cd /d "%~dp0.."

REM 여기서부터 상대경로는 전부 저장소 뿌리 기준이다. 뿌리가 맞는지 확인하고 시작한다.
if not exist "server\package.json" (
  echo *** 저장소 뿌리를 못 찾았습니다: %CD%
  echo *** 이 파일은 vntg-hts\docs\ 안에 있어야 합니다.
  pause
  exit /b 1
)

echo [0/5] 데이터 백업...
REM delims 를 비워 날짜 한 줄을 통째로 받는다.
REM 예전엔 delims=- 로 쪼개고 첫 토막만 써서 폴더 이름이 해마다 하나였다.
for /f "delims=" %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "TODAY=%%a"
set "BK=data-backup\%TODAY%"
if not exist "%BK%" mkdir "%BK%" >nul 2>&1
copy /Y "server\data\*.json" "%BK%\" >nul 2>&1
echo       %BK% 에 저장했습니다.
REM 30일보다 오래된 백업 폴더는 치운다
forfiles /p data-backup /d -30 /c "cmd /c if @isdir==TRUE rd /s /q @path" >nul 2>&1

echo [1/5] 최신 코드 받는 중...
git pull || goto :fail

REM pull 이 데이터 파일을 지웠으면 방금 백업한 것으로 되살린다.
REM 추적 해제 커밋을 처음 받을 때 꼭 필요하고, 그 뒤에는 아무 일도 하지 않는다.
for %%F in (watchlist watchGroups journal paperTrades usWatchlist calendar stockNotes) do (
  if not exist "server\data\%%F.json" (
    if exist "%BK%\%%F.json" (
      copy /Y "%BK%\%%F.json" "server\data\%%F.json" >nul
      echo       복원: %%F.json
    )
  )
)

REM 아직 한 번도 없는 파일이면 씨앗을 깐다.
REM 실제로 쓰는 파일은 git 으로 안 보낸다 - 양쪽 PC 가 고치는 파일이라 pull 이 막힌다.
REM 대신 .seed.json 을 보내고 여기서 최초 1회만 복사한다. 그 뒤로는 이 PC 것을 그대로 둔다.
for %%F in (usWatchlist calendar stockNotes) do (
  if not exist "server\data\%%F.json" (
    if exist "server\data\%%F.seed.json" (
      copy /Y "server\data\%%F.seed.json" "server\data\%%F.json" >nul
      echo       씨앗 설치: %%F.json
    )
  )
)

REM 해외 관심종목만은 이미 있어도 조용히 넘어가지 않는다. 예전에 그래서
REM 새 목록이 안 넘어온 걸 한참 모르고 있었다. 씨앗과 다르면 가져오는 법을 알려 준다.
REM 캘린더와 종목메모는 미니PC 가 스스로 채우는 파일이라 알리지 않는다.
if exist "server\data\usWatchlist.seed.json" (
  fc /b "server\data\usWatchlist.json" "server\data\usWatchlist.seed.json" >nul 2>&1
  if errorlevel 1 (
    echo.
    echo       [알림] 해외 관심종목이 씨앗과 다릅니다.
    echo              이 PC 에서 편집한 것이면 그대로 두시면 됩니다.
    echo              메인PC 목록으로 맞추려면 아래를 실행하세요:
    echo.
    echo              copy /Y server\data\usWatchlist.json server\data\usWatchlist.bak.json
    echo              copy /Y server\data\usWatchlist.seed.json server\data\usWatchlist.json
    echo.
  )
)

echo [2/5] 서버 빌드...
pushd server
call npm install --no-audit --no-fund || goto :fail
call npm run build || goto :fail
popd

echo [3/5] 웹 빌드...
pushd web
call npm install --no-audit --no-fund || goto :fail
call npm run build || goto :fail
popd

echo [4/5] 서비스 재시작...
schtasks /End /TN "VNTG HTS" >nul 2>&1
schtasks /Run /TN "VNTG HTS" >nul 2>&1

echo [5/5] 확인...
timeout /t 5 /nobreak >nul
curl -s http://localhost:4000/api/health
echo.
node -e "const w=require('./server/data/watchlist.json');console.log('관심종목 '+w.length+'개')" 2>nul
node -e "const t=require('./server/data/customThemes.json');console.log('내 테마 '+t.length+'개')" 2>nul
echo.
pause
exit /b 0

:fail
echo.
echo *** 실패했습니다. 위 메시지를 확인하세요. ***
echo *** 데이터는 %BK% 에 백업돼 있습니다. ***
pause
exit /b 1
