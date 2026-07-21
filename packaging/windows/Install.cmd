@echo off
setlocal

set "PLUGIN=%~dp0com.hanbroz.claude-usage.streamDeckPlugin"
set "COMPANION_INSTALLER="

for %%F in ("%~dp0Claude Deck Companion Setup *.exe") do (
  if exist "%%~fF" set "COMPANION_INSTALLER=%%~fF"
)

if not exist "%PLUGIN%" (
  echo [ERROR] The Stream Deck plugin installer was not found.
  echo Expected: %PLUGIN%
  pause
  exit /b 1
)

if not exist "%ProgramFiles%\Elgato\StreamDeck\StreamDeck.exe" if not exist "%ProgramFiles(x86)%\Elgato\StreamDeck\StreamDeck.exe" (
  echo [WARNING] Stream Deck was not found in the standard installation folders.
  echo Install and start Stream Deck before continuing.
  pause
)

if defined COMPANION_INSTALLER (
  echo Installing Claude Deck Companion first.
  echo The Companion installer checks Windows Terminal and opens the bundled Stream Deck plugin when complete.
  start /wait "" "%COMPANION_INSTALLER%"
  if errorlevel 1 (
    echo [ERROR] Claude Deck Companion installation did not finish successfully.
    pause
    exit /b 1
  )
  exit /b 0
)

echo [ERROR] Claude Deck Companion installer was not found in this folder.
echo The release bundle must include "Claude Deck Companion Setup *.exe" so Windows Terminal can be enforced.
pause
exit /b 1
