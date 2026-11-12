@echo off
rem Restart Rina-Chan Board without a console window.
rem Stops the instance on port 8765 (if any), then starts rinari.pyw with pythonw.
rem Open the dashboard from the tray icon or http://127.0.0.1:8765/
cd /d "%~dp0"

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127\.0\.0\.1:8765 .*LISTENING"') do taskkill /pid %%p /f >nul 2>&1
rem wait about 1 second for the port to be released
ping -n 2 127.0.0.1 >nul

start "" pythonw "%~dp0rinari.pyw" --no-browser
