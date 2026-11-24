@echo off
setlocal
title DeepSeek Subagent Verwijderen
if not exist "%~dp0install.mjs" goto :noextract
node "%~dp0install.mjs" --uninstall
goto :done

:noextract
echo.
echo [FOUT] Pak het ZIP-bestand eerst volledig uit voordat je UNINSTALL.cmd opent.

:done
echo.
pause
