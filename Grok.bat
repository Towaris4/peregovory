@echo off
cd /d "%~dp0"
"C:\Users\Ivant\.grok\bin\grok.exe" --cwd "%cd%"
if errorlevel 1 pause
