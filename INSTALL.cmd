@echo off
setlocal
title DeepSeek Subagent Installer
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [FOUT] Node.js is nog niet geinstalleerd.
  echo Download en installeer Node.js (LTS, versie 20+) via: https://nodejs.org/
  echo Start daarna dit bestand opnieuw.
  echo.
  pause
  exit /b 1
)
node "%~dp0install.mjs" %*
echo.
pause
