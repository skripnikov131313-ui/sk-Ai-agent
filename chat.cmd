@echo off
setlocal EnableExtensions DisableDelayedExpansion
call "%~dp0agent.cmd" ui --open %*
set "CHAT_EXIT=%ERRORLEVEL%"
if not "%CHAT_EXIT%"=="0" pause
exit /b %CHAT_EXIT%
