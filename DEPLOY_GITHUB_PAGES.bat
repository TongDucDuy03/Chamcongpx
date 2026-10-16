@echo off
chcp 65001 >nul
title DEPLOY LEN GITHUB PAGES 24/7 - HE THONG BAO TANG CA DIEN THOAI
echo ============================================================================
echo   🚀 CONG CU TU DONG DAY CODE LEN GITHUB PAGES (HOAT DONG 24/7 MOI NOI)
echo ============================================================================
echo.
cd /d "%~dp0"

if not exist ".git" (
    echo [1/4] Khoi tao Git Repository tai thu muc san_pham...
    git init
    git branch -M main
)

echo [2/4] Dong goi giao dien tinh, bo xuat Excel (.xlsx) va workflow GitHub Pages...
git add .
git commit -m "Deploy He Thong Bao Tang Ca 24/7 len GitHub Pages + Cloud RLS" 2>nul

echo.
echo [3/4] Link repo, vi du: https://github.com/TongDucDuy03/Chamcongpx.git
set /p REPO_URL="👉 Dan link GitHub Repo vao day (hoac nhan Enter neu da cai remote origin): "

if not "%REPO_URL%"=="" (
    git remote remove origin 2>nul
    git remote add origin %REPO_URL%
)

echo.
echo [4/4] Dang day len nhanh main (GitHub Actions se tu dong kich hoat GitHub Pages)...
git push -u origin main

echo.
echo ============================================================================
echo ✅ HOAN TAT! Sau khi push xong, Sep vao GitHub Repo -> Settings -> Pages:
echo    Chon Source: "GitHub Actions" (hoac "Deploy from a branch: main").
echo    Link truy cap 24/7 cho cong nhan se co dang:
echo    https://<ten-github-cua-sep>.github.io/<ten-repo>/?mode=worker
echo ============================================================================
pause
