@echo off
cd /d "%~dp0"
start "kiwoom-hts-server" /min cmd /c "server\run-dev.cmd"
start "kiwoom-hts-web" /min cmd /c "web\run-dev.cmd"
