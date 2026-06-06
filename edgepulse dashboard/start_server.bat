@echo off
title EdgePulse Server
cd /d "%~dp0bridge"
echo Installing dependencies...
python -m pip install -r requirements.txt -q
echo.
echo Starting EdgePulse on http://127.0.0.1:8080/
echo Keep this window open while using the dashboard.
echo.
python serial_bridge.py
pause
