@echo off
REM VNTG HTS 상시 실행용. 서버 하나가 API와 웹 화면을 모두 서빙한다.
REM 작업 스케줄러에서 "시스템 시작 시" 이 파일을 실행하도록 등록해서 쓴다.
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0server"
node dist\index.js
