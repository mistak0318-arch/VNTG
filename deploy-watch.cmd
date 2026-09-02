@echo off
REM ===========================================================================
REM  1분마다 예약작업(`VNTG DEPLOY WATCH`)이 부른다.
REM
REM  공유 폴더에 `deploy.flag` 가 떨어져 있으면 지우고 배포한다.
REM  깃발을 **먼저 지우고** 배포한다 ? 나중에 지우면 배포가 실패했을 때
REM  깃발이 남아 1분마다 같은 실패를 무한히 반복한다.
REM
REM  `deploy.lock` 은 겹쳐 도는 것을 막는다. 배포는 3~4분 걸리는데 감시는
REM  1분마다 도니까, 이게 없으면 빌드 중에 또 빌드가 시작된다.
REM  ?? 배포 중에 미니PC 가 꺼지면 자물쇠가 남는다. 그때는 지우면 된다.
REM ===========================================================================
setlocal
cd /d "%~dp0"

set "DROP=C:\vntg-deploy"
if not exist "%DROP%" mkdir "%DROP%"

REM 감시가 살아 있다는 표시 ? 배포를 안 걸어도 이 파일 시각으로 확인할 수 있다
echo %date% %time%> "%DROP%\watch.alive"

if not exist "%DROP%\deploy.flag" exit /b 0
if exist "%DROP%\deploy.lock" exit /b 0

echo %date% %time%> "%DROP%\deploy.lock"
del /q "%DROP%\deploy.flag"

call "%~dp0deploy.cmd"

del /q "%DROP%\deploy.lock"
exit /b 0
