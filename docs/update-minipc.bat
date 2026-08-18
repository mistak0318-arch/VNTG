@echo off
REM 미니PC 전용 — 최신 코드를 받아 빌드하고 서비스를 재시작한다.
REM 메인 PC에서 git push 한 뒤 미니PC에서 이 파일을 더블클릭하면 끝.
REM
REM [0/5] 가 새로 붙었다. watchlist / journal / paperTrades 는 git 추적에서 뺐으므로
REM       이제 원격에 백업본이 없다 — 디스크가 죽으면 그대로 사라진다.
REM       그래서 pull 하기 전에 날짜별로 복사해 둔다. 30일치만 남긴다.
setlocal enabledelayedexpansion
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\cmd;%PATH%"
cd /d "%~dp0"

echo [0/5] 데이터 백업...
for /f "tokens=1-3 delims=-/ " %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "TODAY=%%a"
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
for %%F in (watchlist watchGroups journal paperTrades usWatchlist) do (
  if not exist "server\data\%%F.json" (
    if exist "%BK%\%%F.json" (
      copy /Y "%BK%\%%F.json" "server\data\%%F.json" >nul
      echo       복원: %%F.json
    )
  )
)

REM 해외 관심종목이 아직 한 번도 없으면 씨앗을 깐다.
REM 실제로 쓰는 usWatchlist.json 은 git 으로 안 보낸다 — 양쪽 PC 가 고치는 파일이라
REM pull 이 막히기 때문이다. 대신 usWatchlist.seed.json 을 보내고 여기서 한 번만 복사한다.
REM 그 뒤로는 이 PC 것을 그대로 둔다.
REM 파일이 없으면 그냥 깐다.
if not exist "server\data\usWatchlist.json" (
  if exist "server\data\usWatchlist.seed.json" (
    copy /Y "server\data\usWatchlist.seed.json" "server\data\usWatchlist.json" >nul
    echo       해외 관심종목 씨앗을 깔았습니다.
  )
) else (
  REM 이미 있으면 덮어쓰지 않는다 — 이 PC 에서 편집한 것일 수 있다.
  REM 다만 **조용히 넘어가지는 않는다.** 예전엔 그래서 새 목록이 안 넘어온 걸
  REM 한참 모르고 있었다. 씨앗과 다르면 어떻게 가져오는지 알려 준다.
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
cd server
call npm install --no-audit --no-fund || goto :fail
call npm run build || goto :fail
cd ..

echo [3/5] 웹 빌드...
cd web
call npm install --no-audit --no-fund || goto :fail
call npm run build || goto :fail
cd ..

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
