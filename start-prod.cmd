@echo off
REM ===========================================================================
REM  VNTG HTS 상시 실행용. 서버 하나가 API와 웹 화면을 모두 서빙한다.
REM  작업 스케줄러에서 "시스템 시작 시" 이 파일을 실행하도록 등록해서 쓴다.
REM
REM  ⚠️ **출력을 파일로 받는다** (2026-10-07). 예전엔 `node dist\index.js` 로 끝이라
REM  stdout·stderr 가 **아무 데도 안 갔다.** 10/6 밤 서버가 10분 간격으로 몇 번씩 죽는 동안
REM  사인이 한 줄도 안 남은 이유가 이것이다 — 특히 V8 의 `FATAL ERROR: ... heap out of memory`
REM  는 JS 핸들러로 못 잡고 **stderr 로만** 나오므로, 이 리다이렉트가 OOM 을 가리는 유일한 길이다.
REM
REM  적는 자리는 배포 폴더(`C:\vntg-deploy`)다 — SMB 로 공유돼 있어 미니PC 에 들어가지 않고 밖에서 읽는다.
REM  20MB 를 넘으면 `server.log.1` 로 밀고 새로 시작한다(두 세대만 남긴다).
REM
REM  **되살리는 일은 여기서 안 한다.** `deploy-watch.cmd` 가 1분마다 `/api/health` 를 보고
REM  죽었으면 `schtasks /End` + `/Run` 으로 되살린다 — 재시작을 두 곳에서 하면 서로 싸워서
REM  포트가 겹친다. 책임은 감시자 한 곳에.
REM ===========================================================================
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0server"

set "DROP=C:\vntg-deploy"
if not exist "%DROP%" set "DROP=%~dp0"
set "LOG=%DROP%\server.log"

REM 20MB 넘으면 한 세대 밀어 둔다
for %%A in ("%LOG%") do if %%~zA GTR 20000000 (
  del /q "%LOG%.1" 2>nul
  move /y "%LOG%" "%LOG%.1" >nul 2>&1
)

REM 서버가 「나는 이 스크립트로 떴다」를 health.json 에 적게 한다 — 작업 스케줄러가
REM 이 파일을 쓰는지 node 를 직접 부르는지 밖에서 확인할 길이 그것뿐이다
set "VNTG_LAUNCHER=start-prod"

REM ⚠️ **heap 상한을 올린다** (2026-10-07). 노드 기본 상한이 이 기계에서 2,240MB 인데, 뜨자마자
REM `dailyCloses.json`(84MB)·`signalSamples.json`(38MB) 같은 큰 파일을 통째로 올려 **시작 32초 만에 heap 931MB**,
REM 장중 캐시·실시간이 얹히면 몇 분 만에 상한에 닿아 **OOM 으로 즉사**했다(10/6 밤 10분 주기 사망의 정체).
REM 3,584MB 로 올려 두 배 반의 여유를 준다 — 상한을 올린 것은 시간을 버는 조치이고, 큰 파일을 통째로 안 드는
REM 것이 근본 처방이다. 실제로 얼마나 쓰는지는 health.json 의 「프로세스」가 매일 적는다.
echo.>> "%LOG%"
echo ==== %date% %time% 서버 시작 ====>> "%LOG%"
node --max-old-space-size=3584 dist\index.js >> "%LOG%" 2>&1
echo ==== %date% %time% 서버 끝남 (exit %errorlevel%) ====>> "%LOG%"
