@echo off
chcp 65001 >nul
title [Argon Team] Quan Ly & Kiem Ke Thu Muc San Pham (san_pham)
cd /d "%~dp0"

echo ============================================================================
echo   👑 HE THONG QUAN LY & KIEM KE THU MUC SAN PHAM - ARGON TEAM
echo ============================================================================
echo   [+] Thu muc san pham chinh : %~dp0
echo   [+] Thu muc tai nguyen upload: %~dp0..\uploads\
echo ============================================================================
echo.

echo [1/3] Dang quet & don dep thu vien nang (chong treo dong bo OneDrive)...
if exist "node_modules" (
    echo   - Phat hien node_modules! Dang xoa de bao ve OneDrive...
    rmdir /s /q "node_modules"
)
if exist ".venv" (
    echo   - Phat hien .venv! Dang xoa de bao ve OneDrive...
    rmdir /s /q ".venv"
)
del /q /f "~$*.xlsx" "*.tmp" 2>nul
echo   - Hoan tat: Khong co node_modules, .venv hay file tam gay nghen OneDrive.
echo.

echo [2/3] Danh sach cac file thanh pham hien co trong san_pham:
echo ----------------------------------------------------------------------------
powershell -NoProfile -Command "Get-ChildItem -Path '%~dp0' -Recurse -File | Select-Object @{Name='File';Expression={$_.FullName.Replace('%~dp0','')}}, @{Name='DungLuong(KB)';Expression={[math]::Round($_.Length/1KB,1)}}, LastWriteTime | Format-Table -AutoSize"
echo ----------------------------------------------------------------------------
echo.

echo [3/3] Quy chuan chong ghi de phien ban (YYYYMMDD_ten_du_an):
set /p NEW_PROJ="Nhap ten du an moi de tao thu muc theo chuan YYYYMMDD_ten_du_an (hoac Enter de bo qua): "
if not "%NEW_PROJ%"=="" (
    for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set TODAY=%%i
    call mkdir "%%TODAY%%_%NEW_PROJ%" 2>nul
    echo   [+] Da tao thu muc phien ban moi: "%~dp0%TODAY%_%NEW_PROJ%"
)

echo.
echo Mo thu muc san_pham tren Windows Explorer...
explorer "%~dp0"
pause
