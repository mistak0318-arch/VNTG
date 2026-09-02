@echo off
REM ===========================================================================
REM  미니PC 전용 — 무인 배포. `update.cmd` 의 pause 없는 판.
REM
REM  사람이 더블클릭하는 update.cmd 와 하는 일은 같지만, 두 가지가 다르다:
REM    · pause 가 없다 — 예약작업이 부르므로 멈춰 서면 안 된다
REM    · 모든 출력을 공유 폴더의 로그로 뺀다 — 메인 PC 에서 결과를 읽어야 하므로
REM
REM  실패하면 서비스를 **재시작하지 않는다.** 빌드가 깨졌는데 재시작하면
REM  멀쩡히 돌던 것까지 죽는다. 옛 빌드를 그대로 굴리는 편이 낫다.
REM ===========================================================================
setlocal
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\cmd;%PATH%"
cd /d "%~dp0"

set "DROP=C:\vntg-deploy"
set "LOG=%DROP%\deploy.log"
set "ST=%DROP%\deploy.status"
if not exist "%DROP%" mkdir "%DROP%"

echo ==== %date% %time% 배포 시작 ====> "%LOG%"

echo.>> "%LOG%"
echo [1/4] 최신 코드 받는 중...>> "%LOG%"
git pull>> "%LOG%" 2>&1 || goto :fail

echo.>> "%LOG%"
echo [2/4] 서버 빌드...>> "%LOG%"
cd server
call npm install --no-audit --no-fund>> "%LOG%" 2>&1 || goto :fail
call npm run build>> "%LOG%" 2>&1 || goto :fail
cd ..

echo.>> "%LOG%"
echo [3/4] 웹 빌드...>> "%LOG%"
cd web
call npm install --no-audit --no-fund>> "%LOG%" 2>&1 || goto :fail
call npm run build>> "%LOG%" 2>&1 || goto :fail
cd ..

echo.>> "%LOG%"
echo [4/4] 서비스 재시작...>> "%LOG%"
schtasks /End /TN "VNTG HTS" >nul 2>&1
schtasks /Run /TN "VNTG HTS" >nul 2>&1

REM 서버가 뜨는 데 시간이 걸린다. 8초 주고 살아 있는지 물어본다
timeout /t 8 /nobreak >nul
echo.>> "%LOG%"
echo -- /api/health -->> "%LOG%"
curl -s -m 10 http://localhost:4000/api/health>> "%LOG%" 2>&1
echo.>> "%LOG%"

echo ==== %date% %time% 완료 ====>> "%LOG%"
echo OK %date% %time%> "%ST%"
git rev-parse --short HEAD>> "%ST%" 2>&1
exit /b 0

:fail
echo.>> "%LOG%"
echo *** 실패했습니다. 위 메시지를 확인하세요. ***>> "%LOG%"
echo ==== %date% %time% 실패 ====>> "%LOG%"
echo FAIL %date% %time%> "%ST%"
git rev-parse --short HEAD>> "%ST%" 2>&1
exit /b 1
