@echo off
chcp 65001 >nul
title HE THONG BAO TANG CA DIEN THOAI VA QUAN TRI XUAT EXCEL 10_2026
echo ============================================================================
echo   KHOI DONG MAY CHU TAP TRUNG: BAO TANG CA DIEN THOAI (3 CHAM)
echo   Du lieu luu tai: san_pham\data\overtime_db.json
echo ============================================================================
start "" "http://localhost:3080"
node "%~dp0server.js"
pause
