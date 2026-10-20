@echo off
chcp 65001 >nul
title Zalo Emergency Monitor
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [LOI] Khong tim thay Node.js. Hay cai Node.js tai https://nodejs.org roi chay lai file nay.
    pause
    exit /b 1
)

if exist "node_modules\playwright" goto start
echo Dang cai thu vien lan dau, cho mot chut...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [LOI] Cai thu vien that bai. Xem thong bao loi ben tren.
    pause
    exit /b 1
)

:start
rem Chi mo giao dien o lan chay dau, khong mo lai moi lan bot tu khoi dong lai
set OPEN_FLAG=--open

:run
echo ============================================================
echo   ZALO EMERGENCY MONITOR - dang khoi dong...
echo   Giao dien quan ly: http://127.0.0.1:3939
echo   Nhan Ctrl+C roi bam Y de dung bot
echo ============================================================
node src/index.js %OPEN_FLAG%
set EXIT_CODE=%errorlevel%
set OPEN_FLAG=
if %EXIT_CODE% equ 2 (
    echo.
    echo [!] Bot dang chay o mot cua so khac. Mo giao dien: http://127.0.0.1:3939
    pause
    exit /b 2
)
echo.
echo [%date% %time%] Bot da dung (ma loi: %EXIT_CODE%). Tu khoi dong lai sau 10 giay...
"%SystemRoot%\System32\ping.exe" -n 11 127.0.0.1 >nul
goto run
