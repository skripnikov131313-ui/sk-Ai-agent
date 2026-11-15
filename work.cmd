@echo off
setlocal EnableExtensions DisableDelayedExpansion
call "%~dp0agent.cmd" work %*
set "WORK_EXIT=%ERRORLEVEL%"
echo.
echo Work finished with code %WORK_EXIT%. Progress: agent.cmd work-status
pause
exit /b %WORK_EXIT%
