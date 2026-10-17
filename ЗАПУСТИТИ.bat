@echo off
cd /d "%~dp0"
chcp 65001 >nul
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js не найден / Node.js не знайдено.
  echo Установите с https://nodejs.org  и запустите снова.
  echo.
  pause
  exit /b 1
)
start "Переговори" /min /d "%~dp0" node server.js
timeout /t 2 /nobreak >nul
start "Переговори — інтернет" /min /d "%~dp0" node tunnel.js
exit /b 0
