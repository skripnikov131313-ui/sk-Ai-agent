@echo off
setlocal
set "NODE_EXE="

rem An explicit, per-session override does not modify the system PATH.
if defined SKAI_NODE_EXE (
  if not exist "%SKAI_NODE_EXE%" (
    echo SKAI_NODE_EXE does not point to an existing node.exe.
    exit /b 9009
  )
  set "NODE_EXE=%SKAI_NODE_EXE%"
  goto node_found
)

for /f "delims=" %%N in ('where.exe node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%~fN"
if defined NODE_EXE goto node_found

rem An existing installation may be absent from this terminal's PATH.
for %%N in (
  "%ProgramFiles%\nodejs\node.exe"
  "%ProgramFiles(x86)%\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\nodejs\node.exe"
  "%LOCALAPPDATA%\nodejs\node.exe"
) do if not defined NODE_EXE if exist "%%~fN" set "NODE_EXE=%%~fN"
if defined NODE_EXE goto node_found

rem MSIX packages can use either an underscore or a dot before the version.
for /d %%D in ("%ProgramFiles%\WindowsApps\OpenAI.CodexPrimaryRuntime*") do (
  if not defined NODE_EXE if exist "%%~fD\dependencies\node\bin\node.exe" set "NODE_EXE=%%~fD\dependencies\node\bin\node.exe"
)
if defined NODE_EXE goto node_found

echo Node.js was not found in PATH, standard install folders, or the Codex runtime.
echo To install Node.js LTS, run this command yourself in PowerShell:
echo   winget install --id OpenJS.NodeJS.LTS --exact --source winget
echo Then close and reopen PowerShell and retry agent.cmd doctor.
echo For an existing runtime, set SKAI_NODE_EXE to its full node.exe path.
exit /b 9009

:node_found
"%NODE_EXE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. The selected runtime could not pass this check.
  echo Install Node.js LTS or set SKAI_NODE_EXE to a compatible node.exe.
  exit /b 1
)
"%NODE_EXE%" "%~dp0src\cli.mjs" %*
exit /b %ERRORLEVEL%
