@echo off
REM ===========================================================================
REM  예약작업(`VNTG DEPLOY WATCH`)이 1분마다 부른다 — 한 번 돌 때 **5초마다** 열한 번 살핀다.
REM
REM  처음엔 한 번 보고 끝냈다. 예약작업 최소 주기가 1분이라 깃발을 꽂고 30초를
REM  그냥 기다렸다 — 벤티지: "배포가 돌아간 것 같은데 왜 계속 체크 중이더라고".
REM  그래서 한 번 불리면 55초 동안 5초마다 본다. 예약작업은 한 인스턴스만 돌게 돼 있어
REM  (기본 정책) 겹치지 않는다.
REM
REM  하는 일 둘:
REM    ① 배포 깃발(`deploy.flag`)이 있으면 배포한다
REM    ② **서버 생사 확인 — 죽었으면 되살린다** (2026-10-07)
REM
REM  ②를 넣은 이유 (벤티지: "결정적으로 죽었을때 다시 살리려면 원격으로 들어가서
REM  서버 재부팅해야한다는거야. 이거 고쳐 봐봐"). 10/6 밤 서버가 10분 간격으로 몇 번씩
REM  죽었는데, 그때마다 사람이 미니PC 에 원격으로 들어가 작업을 다시 돌려야 했다.
REM  이 감시자는 **이미 1분마다 돌고 있으므로** 여기 네 줄이면 사람 손이 필요 없어진다.
REM
REM  살아 있음의 기준은 `/api/health` 응답이다(프로세스가 떠 있어도 먹통이면 소용없다).
REM  ⚠️ **한 번 실패로 재시작하지 않는다** — 빌드 중·부팅 직후·일시적 지연이 있다.
REM  연속 세 번(약 15초) 응답이 없을 때만, 그리고 **배포 중이 아닐 때만** 되살린다.
REM  되살릴 때는 `/End` 로 먼저 끊는다 — 프로세스가 살아 있는데 먹통이면 `/Run` 이 무시되기 때문.
REM  한 일은 `restart.log` 에 남긴다(공유 폴더라 밖에서 읽힌다).
REM
REM  `deploy.lock` 이 있을 때는 배포를 안 띄운다.
REM  ※ 배포 중에 미니PC 가 멈추면 자물쇠가 남는다. 그때는 지우면 된다.
REM ===========================================================================
setlocal
cd /d "%~dp0"

set "DROP=C:\vntg-deploy"
if not exist "%DROP%" mkdir "%DROP%"

set /a N=0
set /a DEAD=0
:loop
REM 감시가 돌고 있다는 표시 — 깃발을 꽂아 두고 몇 초쯤인지 확인할 수 있다
echo %date% %time%> "%DROP%\watch.alive"

if exist "%DROP%\deploy.flag" if not exist "%DROP%\deploy.lock" (
  echo %date% %time%> "%DROP%\deploy.lock"
  del /q "%DROP%\deploy.flag"
  call "%~dp0deploy.cmd"
  del /q "%DROP%\deploy.lock"
  set /a DEAD=0
)

REM ── 서버 생사 ────────────────────────────────────────────────────────────
REM 배포 중에는 서버가 내려가 있는 게 정상이므로 건너뛴다
if exist "%DROP%\deploy.lock" (
  set /a DEAD=0
) else (
  curl -s -f -m 4 -o nul http://localhost:4000/api/health
  if errorlevel 1 (set /a DEAD+=1) else (set /a DEAD=0)
)

if %DEAD% GEQ 3 (
  echo %date% %time% 응답 없음 %DEAD%회 - 되살린다>> "%DROP%\restart.log"
  schtasks /End /TN "VNTG HTS" >nul 2>&1
  timeout /t 2 /nobreak >nul
  schtasks /Run /TN "VNTG HTS" >nul 2>&1
  set /a DEAD=0
  REM 뜨는 데 시간이 걸린다 — 다음 판정까지 20초 준다
  timeout /t 20 /nobreak >nul
)

set /a N+=1
if %N% GEQ 11 exit /b 0
timeout /t 5 /nobreak >nul
goto :loop
