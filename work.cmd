@echo off
setlocal EnableExtensions DisableDelayedExpansion
call "%~dp0agent.cmd" work-start %*
set "WORK_EXIT=%ERRORLEVEL%"
echo.
echo Background launch returned code %WORK_EXIT%. Progress: agent.cmd work-status
pause
exit /b %WORK_EXIT%
