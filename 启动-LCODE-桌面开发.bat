@echo off
rem ============================================================
rem  L-CODE Desktop - one-click dev launcher
rem  Double-click this file to run:
rem    cd D:\1_ai_project\mcu_ai_agent\lcode\desktop
rem    npm run dev
rem  The console window stays open after the process exits.
rem ============================================================

title L-CODE Desktop Dev

set "APP_DIR=D:\1_ai_project\mcu_ai_agent\lcode\desktop"

rem ---- check app folder ----
if not exist "%APP_DIR%\package.json" (
    echo [ERROR] package.json not found in %APP_DIR%
    echo         Please check the project path.
    pause
    exit /b 1
)

rem ---- check npm ----
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm not found in PATH. Please install Node.js first.
    pause
    exit /b 1
)

cd /d "%APP_DIR%"

rem ---- install dependencies only when missing ----
if not exist "node_modules" (
    echo [INFO] node_modules not found, running npm install ...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo.
echo ============================================================
echo  Starting L-CODE desktop dev server ...
echo  Working directory: %CD%
echo.
echo  - Press Ctrl+C to stop the dev server.
echo  - The window stays open after it exits.
echo ============================================================
echo.

call npm run dev

echo.
echo [DONE] "npm run dev" exited with code %ERRORLEVEL%.
echo You may close this window now.
pause
