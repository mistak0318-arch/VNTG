@echo off
rem Web dev server that sends /api to the mini PC, not a local backend.
rem Use this during market hours: a local server would split the Kiwoom quota.
set "PATH=C:\Program Files\nodejs;%PATH%"
set "VNTG_API=http://100.88.182.35:4000"
cd /d "%~dp0"
call npm run dev
