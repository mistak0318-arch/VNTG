@echo off
REM 메인 PC 전용 — 변경사항을 커밋하고 GitHub에 올린다.
REM 더블클릭하면 실행되고, 커밋 메시지만 입력하면 끝.
REM (미니PC에서는 update.cmd 를 쓴다)
setlocal
set "PATH=C:\Program Files\Git\cmd;%PATH%"
cd /d "%~dp0"

echo ===== 변경된 파일 =====
git status --short
echo.

REM 변경사항이 없으면 커밋을 건너뛰고 push만 시도 (밀린 커밋이 있을 수 있음)
git diff --quiet && git diff --cached --quiet
if %errorlevel%==0 (
  echo 변경된 파일이 없습니다. 밀린 커밋만 올립니다.
  goto :push
)

set "MSG="
set /p "MSG=커밋 메시지 (그냥 엔터 치면 날짜로): "
if "%MSG%"=="" set "MSG=작업 저장 %date% %time:~0,5%"

git add -A || goto :fail
git commit -m "%MSG%" || goto :fail

:push
echo.
echo ===== GitHub에 올리는 중 =====
REM 처음 한 번은 브라우저 로그인 창이 뜬다. 이후로는 자동.
git push || goto :fail

echo.
echo ===== 완료 =====
git log --oneline -3
echo.
echo 미니PC에서 update.cmd 를 실행하면 반영됩니다.
pause
exit /b 0

:fail
echo.
echo *** 실패했습니다. 위 메시지를 확인하세요. ***
echo  - "rejected" 라면: git pull 먼저 하세요
echo  - 인증 창이 안 뜨면: 이 창에서 git push 를 직접 실행해보세요
pause
exit /b 1
