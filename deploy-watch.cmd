@echo off
REM ===========================================================================
REM  예약작업(`VNTG DEPLOY WATCH`)이 1분마다 부른다 ? 그 1분 동안 **5초마다** 깃발을 본다.
REM
REM  처음엔 한 번 보고 끝났다. 예약작업 최소 주기가 1분이라 깃발이 평균 30초를
REM  그냥 기다렸다 ? 벤티지: "서버는 돌아간 지 한참인데 넌 계속 체크 중이더라고".
REM  그래서 한 번 불리면 55초 동안 5초마다 본다. 예약작업은 앞 인스턴스가 돌고 있으면
REM  새 인스턴스를 안 띄우므로(기본 정책) 겹치지 않는다.
REM
REM  공유 폴더에 `deploy.flag` 가 떨어져 있으면 지우고 배포한다.
REM  깃발을 **먼저 지우고** 배포한다 ? 나중에 지우면 배포가 실패했을 때
REM  깃발이 남아 같은 실패를 무한히 반복한다.
REM
REM  `deploy.lock` 은 겹쳐 도는 것을 막는다.
REM  ?? 배포 중에 미니PC 가 꺼지면 자물쇠가 남는다. 그때는 지우면 된다.
REM ===========================================================================
setlocal
cd /d "%~dp0"

set "DROP=C:\vntg-deploy"
if not exist "%DROP%" mkdir "%DROP%"

set /a N=0
:loop
REM 감시가 살아 있다는 표시 ? 배포를 안 걸어도 이 파일 시각으로 확인할 수 있다
echo %date% %time%> "%DROP%\watch.alive"

if exist "%DROP%\deploy.flag" if not exist "%DROP%\deploy.lock" (
  echo %date% %time%> "%DROP%\deploy.lock"
  del /q "%DROP%\deploy.flag"
  call "%~dp0deploy.cmd"
  del /q "%DROP%\deploy.lock"
)

set /a N+=1
if %N% GEQ 11 exit /b 0
timeout /t 5 /nobreak >nul
goto :loop
