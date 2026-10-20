@echo off
chcp 65001 >nul
title Zalo Monitor - Quet ma QR
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [LOI] Khong tim thay Node.js. Hay cai Node.js tai https://nodejs.org roi chay lai file nay.
    pause
    exit /b 1
)

echo ============================================================
echo   QUET MA QR DANG NHAP ZALO WEB
echo   Mo Zalo tren dien thoai -^> Quet ma QR tren cua so Chromium
echo ============================================================
node src/index.js --headless=false
echo.
pause
