@echo off
REM ===========================================================================
REM  미니PC 에서 **한 번만** 실행한다. 반드시 「관리자 권한으로 실행」.
REM
REM  하는 일 셋:
REM    1. 깃발을 주고받을 폴더 C:\vntg-deploy 를 만든다
REM    2. 그 폴더만 공유한다 (저장소 폴더는 공유하지 않는다 — 아래 참고)
REM    3. 1분마다 깃발을 살피는 예약작업을 건다
REM
REM  ⚠️ **저장소 폴더를 공유하면 안 된다.** 거기엔 .env(텔레그램 세션 문자열·
REM     API 키)와 server\data(되살릴 수 없는 원장)가 들어 있다. 그래서 깃발과
REM     로그만 오가는 빈 폴더를 따로 두고 그것만 내준다.
REM ===========================================================================
setlocal

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo *** 관리자 권한이 필요합니다. 이 파일을 우클릭 - 관리자 권한으로 실행 ***
  echo.
  pause
  exit /b 1
)

set "DROP=C:\vntg-deploy"
set "ACCT=VNTG"

echo [1/3] 깃발 폴더 만들기 - %DROP%
if not exist "%DROP%" mkdir "%DROP%"

echo.
echo [2/3] 공유 내주기 - \\^<이 PC^>\vntg-deploy
net share vntg-deploy >nul 2>&1 && net share vntg-deploy /delete >nul 2>&1
net share vntg-deploy="%DROP%" /GRANT:%ACCT%,FULL
if errorlevel 1 (
  echo.
  echo *** 공유에 실패했습니다. 계정 이름이 %ACCT% 가 맞는지 확인하세요. ***
  echo     맞는 이름은 아래 목록에 있습니다:
  wmic useraccount where "localaccount=true" get name 2>nul
  pause
  exit /b 1
)

echo.
echo [3/3] 예약작업 걸기 - VNTG DEPLOY WATCH (1분마다)
schtasks /Create /TN "VNTG DEPLOY WATCH" /TR "\"%~dp0deploy-watch.cmd\"" /SC MINUTE /MO 1 /RL HIGHEST /F
if errorlevel 1 (
  echo.
  echo *** 예약작업 등록에 실패했습니다. ***
  pause
  exit /b 1
)

echo.
echo ===========================================================
echo  끝났습니다.
echo.
echo  1분 안에 %DROP%\watch.alive 파일이 생기면 정상입니다.
echo  그 뒤로는 메인 PC 에서 깃발만 떨구면 배포가 돕니다.
echo ===========================================================
echo.
pause
exit /b 0
