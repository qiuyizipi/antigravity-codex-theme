@echo off
chcp 65001 >nul
title Antigravity Codex Theme Installer

set "NODE_CMD="
where node >nul 2>nul
if %errorlevel%==0 set "NODE_CMD=node"
if defined NODE_CMD goto NODE_READY

if exist "C:\Program Files\nodejs\node.exe" set "NODE_CMD=C:\Program Files\nodejs\node.exe"
if defined NODE_CMD goto NODE_READY
if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_CMD=C:\Program Files (x86)\nodejs\node.exe"
if defined NODE_CMD goto NODE_READY
if exist "%LOCALAPPDATA%\Programs\node\node.exe" set "NODE_CMD=%LOCALAPPDATA%\Programs\node\node.exe"
if defined NODE_CMD goto NODE_READY
if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE_CMD=%NVM_SYMLINK%\node.exe"
if defined NODE_CMD goto NODE_READY
if exist "%USERPROFILE%\scoop\shims\node.exe" set "NODE_CMD=%USERPROFILE%\scoop\shims\node.exe"
if defined NODE_CMD goto NODE_READY
if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE_CMD=%LOCALAPPDATA%\Volta\bin\node.exe"
if defined NODE_CMD goto NODE_READY

echo.
echo [ERROR] Node.js not found. Please install Node.js LTS from:
echo   https://nodejs.org/
echo.
pause
exit /b 1

:NODE_READY
"%NODE_CMD%" "%~dp0patch_theme.js" %*
echo.
pause
