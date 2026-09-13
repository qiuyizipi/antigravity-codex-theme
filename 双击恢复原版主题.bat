@echo off
chcp 65001 >nul
title Antigravity 恢复官方原版主题
echo ========================================================
echo            Antigravity 恢复官方原版主题
echo ========================================================
echo.
python "%~dp0patch_theme.py" --uninstall
echo.
pause
