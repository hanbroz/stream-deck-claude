@echo off
setlocal

set "PLUGIN=%~dp0com.hanbroz.claude-usage.streamDeckPlugin"

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

start "" "%PLUGIN%"
if errorlevel 1 (
  echo [ERROR] Windows could not open the plugin installer.
  pause
  exit /b 1
)

echo Stream Deck should now display an installation confirmation window.
echo Approve the installation in Stream Deck to finish.
pause
exit /b 0
