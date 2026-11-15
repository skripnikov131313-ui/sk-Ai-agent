@echo off
setlocal
call "%~dp0agent.cmd" local
set "LOCAL_EXIT=%ERRORLEVEL%"
if not "%LOCAL_EXIT%"=="0" pause
exit /b %LOCAL_EXIT%
