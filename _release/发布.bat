@echo off
rem 一键打包发布文件（双击运行即可）
setlocal
cd /d "%~dp0.."
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Users\ipai\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
"%NODE%" "_release\build-release.js"
echo.
pause
