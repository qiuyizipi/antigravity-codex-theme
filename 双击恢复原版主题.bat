@echo off
chcp 65001 >nul
title Antigravity 恢复官方原版主题
echo ========================================================
echo            Antigravity 恢复原版主题样式
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js ^(https://nodejs.org/^)
    pause
    exit /b 1
)

node "%~dp0patch_theme.js" --uninstall %*
echo.
pause
