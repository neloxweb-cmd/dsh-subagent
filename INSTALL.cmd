@echo off
setlocal
title DeepSeek Subagent Installer
if not exist "%~dp0install.mjs" goto :noextract
where node >nul 2>nul
if errorlevel 1 goto :nonode
node "%~dp0install.mjs" %*
goto :done

:noextract
echo.
echo [FOUT] Pak het ZIP-bestand eerst volledig uit!
echo Rechtermuisknop op de zip -^> Alles uitpakken, en open daarna INSTALL.cmd in de uitgepakte map.
goto :done

:nonode
echo.
echo [FOUT] Node.js is nog niet geinstalleerd.
echo Download en installeer Node.js LTS versie 20+ via: https://nodejs.org/
echo Start daarna INSTALL.cmd opnieuw.
goto :done

:done
echo.
pause
