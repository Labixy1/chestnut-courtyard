@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUTF8=1

where py >nul 2>nul
if %errorlevel%==0 goto use_py

where python >nul 2>nul
if %errorlevel%==0 goto use_python

echo [栗壳小院] 没有找到 Python。
echo 请先安装 Python 3.11 或更新版本，并勾选 Add Python to PATH。
pause
exit /b 1

:use_py
start "栗壳小院服务" cmd /k "pushd ""%~dp0"" && set PYTHONUTF8=1 && py -3 scripts\cozy_server.py --port 8766"
goto open_home

:use_python
start "栗壳小院服务" cmd /k "pushd ""%~dp0"" && set PYTHONUTF8=1 && python scripts\cozy_server.py --port 8766"

:open_home
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8766/index.html"
exit /b 0
