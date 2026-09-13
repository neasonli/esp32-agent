@echo off
rem ============================================================
rem  LCode installer build - double-click menu
rem
rem  This .bat stays ASCII-only on purpose: cmd.exe + Windows
rem  PowerShell 5.1 mishandle UTF-8 BOM / ANSI Chinese, which
rem  breaks the script. Chinese docs live in docs\一键打包.md
rem ============================================================
title LCode installer build

set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build-installer.ps1""

:menu
cls
echo ============================================================
echo   LCode installer build
echo ============================================================
echo.
echo   [1] Base variant   : no ESP-IDF   (~150 MB installer)
echo       for users who already have an ESP-IDF environment
echo.
echo   [2] Full variant   : with ESP-IDF (~1.2 GB installer)
echo       works out of the box (recommended for new users)
echo.
echo   [3] Both variants
echo.
echo   [4] Full variant, rebuild kernel + re-stage ESP-IDF
echo       (use after changing kernel code or ESP-IDF version)
echo.
echo   [0] Exit
echo.
set /p choice="Choose [0-4]: "

if "%choice%"=="1" %PS% -Variant base
if "%choice%"=="2" %PS% -Variant full
if "%choice%"=="3" %PS% -Variant all
if "%choice%"=="4" %PS% -Variant full -RebuildKernel -RestageEspIdf
if "%choice%"=="0" exit /b 0
if not "%choice%"=="1" if not "%choice%"=="2" if not "%choice%"=="3" if not "%choice%"=="4" if not "%choice%"=="0" goto menu

echo.
echo ============================================================
echo  Build finished. Artifacts are in: lcode\desktop\dist
echo ============================================================
pause
goto menu
