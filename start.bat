@echo off
rem 璃奈ちゃんボードを起動してブラウザで開く（終了はこのウィンドウで Ctrl+C）
cd /d "%~dp0"
python -m rinari %*
if errorlevel 1 pause
