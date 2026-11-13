@echo off
setlocal
set "NODE_EXE=node.exe"
where.exe node.exe >nul 2>nul
if errorlevel 1 (
  set "NODE_EXE="
  for /d %%D in ("%ProgramFiles%\WindowsApps\OpenAI.CodexPrimaryRuntime.*") do (
    if exist "%%~fD\dependencies\node\bin\node.exe" set "NODE_EXE=%%~fD\dependencies\node\bin\node.exe"
  )
)
if not defined NODE_EXE (
  echo Node.js not found. Add node.exe to PATH or install Node.js LTS.
  exit /b 9009
)
"%NODE_EXE%" "%~dp0src\cli.mjs" %*
exit /b %ERRORLEVEL%
