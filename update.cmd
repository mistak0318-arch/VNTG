@echo off
REM 미니PC 전용 — 최신 코드를 받아 빌드하고 서비스를 재시작한다.
REM 메인 PC에서 git push 한 뒤 미니PC에서 이 파일을 더블클릭하면 끝.
setlocal
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\cmd;%PATH%"
cd /d "%~dp0"

echo [1/4] 최신 코드 받는 중...
git pull || goto :fail

echo [2/4] 서버 빌드...
cd server
call npm install --no-audit --no-fund || goto :fail
call npm run build || goto :fail
cd ..

echo [3/4] 웹 빌드...
cd web
call npm install --no-audit --no-fund || goto :fail
call npm run build || goto :fail
cd ..

echo [4/4] 서비스 재시작...
schtasks /End /TN "VNTG HTS" >nul 2>&1
schtasks /Run /TN "VNTG HTS" >nul 2>&1

echo.
echo 완료. 확인:
timeout /t 5 /nobreak >nul
curl -s http://localhost:4000/api/health
echo.
pause
exit /b 0

:fail
echo.
echo *** 실패했습니다. 위 메시지를 확인하세요. ***
pause
exit /b 1
