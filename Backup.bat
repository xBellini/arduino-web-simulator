@echo off
REM What: One-click local snapshot — runs backup-local.ps1 (robocopy sibling folder + prune to 10).
REM How-to: double-click this file, or run `Backup.bat` from the repo folder. Window stays open
REM until you press a key so you can read the destination path. Exception Avast on this .bat
REM and/or backup-local.ps1 if needed (stable paths — not Cursor temp wrappers).
REM
REM Changelog:
REM - 05-10-2026 — Call PowerShell via System32 full path (PATH may omit "powershell")
REM - 05-10-2026 — Changelog creation / double-click wrapper for backup-local.ps1
setlocal
cd /d "%~dp0"

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" (
  echo PowerShell not found at:
  echo   %PS%
  echo Install Windows PowerShell or fix PATH, then try again.
  pause
  exit /b 1
)

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup-local.ps1"
set "ERR=%ERRORLEVEL%"

echo.
if not "%ERR%"=="0" (
  echo Backup failed with exit code %ERR%.
) else (
  echo Backup finished OK.
)
pause
exit /b %ERR%
