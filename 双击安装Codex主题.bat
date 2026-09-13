@echo off
chcp 65001 >nul
title Antigravity Codex 主题安装器
echo ========================================================
echo        Antigravity 1:1 Codex 桌面端美化补丁安装
echo ========================================================
echo.
python "%~dp0patch_theme.py"
echo.
pause
