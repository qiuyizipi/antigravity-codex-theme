@echo off
chcp 65001 >nul
title Antigravity Codex Theme Restore

set "NODE_CMD=node"
where node >nul 2>nul
if %errorlevel%==0 goto NODE_READY

if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files\nodejs\node.exe"
    set "PATH=C:\Program Files\nodejs;%PATH%"
    goto NODE_READY
)
if exist "C:\Program Files (x86)\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files (x86)\nodejs\node.exe"
    set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
    goto NODE_READY
)
if exist "%LOCALAPPDATA%\Programs\node\node.exe" (
    set "NODE_CMD=%LOCALAPPDATA%\Programs\node\node.exe"
    set "PATH=%LOCALAPPDATA%\Programs\node;%PATH%"
    goto NODE_READY
)

echo.
echo [ERROR] Node.js not found. Please install Node.js LTS from:
echo   https://nodejs.org/
echo.
pause
exit /b 1

:NODE_READY
"%NODE_CMD%" "%~dp0patch_theme.js" --uninstall %*
echo.
pause
