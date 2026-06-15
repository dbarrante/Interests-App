@echo off
REM ============================================================
REM  Start the Interests App local server and open it.
REM  Double-click this file whenever "localhost refused to connect".
REM  Keep the console window open while you use the app; closing
REM  it stops the server.
REM ============================================================
title Interests App server (keep open)
cd /d "%~dp0"

REM open the app in the default browser after a short delay
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3456"

echo Serving the Interests App at http://localhost:3456
echo Close this window to stop the server.
echo.

REM try the Windows launcher first, then plain python
py -m http.server 3456 2>nul || python -m http.server 3456
