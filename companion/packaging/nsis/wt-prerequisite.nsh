!include LogicLib.nsh

!macro customInit
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "if (Get-Command wt.exe -ErrorAction SilentlyContinue) { exit 0 }; if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { exit 20 }; winget install --id Microsoft.WindowsTerminal -e --source winget --silent --accept-package-agreements --accept-source-agreements; if ($$LASTEXITCODE -ne 0) { exit 21 }; if (Get-Command wt.exe -ErrorAction SilentlyContinue) { exit 0 }; exit 22"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Windows Terminal이 필요하지만 자동 설치 또는 확인에 실패했습니다.$\r$\n$\r$\nPowerShell에서 다음 명령을 직접 실행한 뒤 다시 설치하십시오:$\r$\nwinget install --id Microsoft.WindowsTerminal -e --source winget$\r$\n$\r$\n수동 설치 안내: https://learn.microsoft.com/windows/terminal/install"
    Abort
  ${EndIf}
!macroend

!macro customInstall
  ${If} ${FileExists} "$INSTDIR\resources\com.hanbroz.claude-usage.streamDeckPlugin"
    ExecShell "open" "$INSTDIR\resources\com.hanbroz.claude-usage.streamDeckPlugin"
  ${EndIf}
!macroend
