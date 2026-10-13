@echo off
REM What: Windows one-click launcher — verifies Node.js, runs npm install if needed, frees port
REM 5173 via dev:stop, opens the browser after a short delay, and starts the Vite dev server.
REM How-to: double-click this file or run `Localhost_starter.bat` from the repo folder; keep the window open
REM while developing (closing it stops the server). First launch may run `npm install`. Browser opens
REM http://localhost:5173/ — change the URL in the `start http://localhost:5173/` line if you edit
REM `server.port` in vite.config.js (and align `npm run dev:stop` / VITE_PORT). To skip auto-open, remove or
REM comment the `start "" cmd /c "timeout...` block.
REM
REM Changelog
REM Date       | Author | Remarks
REM 17-09-2026 | Cursor | Changelog creation
REM                     | Expanded What with practical how-to notes
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install from https://nodejs.org/ then try again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

REM Free the port if a previous Vite is stuck.
call npm run dev:stop

REM Open the browser shortly after Vite starts.
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:5173/"

echo Starting Arduino Simulator at http://localhost:5173/
echo Close this window to stop the server.
echo.
call npm run dev
pause
