@echo off
chcp 65001 >nul
title Antigravity Codex 主题安装器
echo ========================================================
echo      Antigravity 1:1 Codex 桌面端美化补丁（无损原地注入）
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js ^(https://nodejs.org/^)
    pause
    exit /b 1
)

node "%~dp0patch_theme.js" %*
echo.
pause
