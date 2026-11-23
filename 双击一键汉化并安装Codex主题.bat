@echo off
chcp 65001 >nul
title Antigravity 一键中文汉化 + Codex 主题安装器
echo ========================================================
echo   Antigravity 一键联动最新中文汉化 + Codex v4.0 主题
echo ========================================================
echo  说明：自动拉取 Silas-02/antigravity-desktop-cn 最新汉化
echo        随后使用无损原地封包引擎叠加注入 Codex 视觉主题
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js ^(https://nodejs.org/^)
    pause
    exit /b 1
)

node "%~dp0patch_theme.js" --with-cn %*
echo.
pause
