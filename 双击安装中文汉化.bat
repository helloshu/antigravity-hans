@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Antigravity 中文汉化安全安装工具

set "NODE_CMD="
if exist "C:\Program Files\nodejs\node.exe" set "NODE_CMD=C:\Program Files\nodejs\node.exe"
if not defined NODE_CMD if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_CMD=C:\Program Files (x86)\nodejs\node.exe"
if not defined NODE_CMD if exist "%LOCALAPPDATA%\Programs\node\node.exe" set "NODE_CMD=%LOCALAPPDATA%\Programs\node\node.exe"
if not defined NODE_CMD if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE_CMD=%NVM_SYMLINK%\node.exe"
if not defined NODE_CMD if defined NVM_HOME if exist "%NVM_HOME%\node.exe" set "NODE_CMD=%NVM_HOME%\node.exe"
if not defined NODE_CMD (
    where node >nul 2>nul
    if not errorlevel 1 set "NODE_CMD=node"
)

if not defined NODE_CMD (
    echo.
    echo [错误] 未检测到 Node.js 运行环境（建议 v18 或更高版本）。
    echo 请先安装 Node.js LTS 版本后重试：https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo.
echo ==========================================
echo   Antigravity 中文汉化安全安装工具
echo ==========================================
echo.
echo 请选择左上角品牌显示方式：
echo   [1] 显示英文 Antigravity（默认推荐）
echo   [2] 不显示品牌名
echo   [3] 显示中文品牌名
echo.
choice /c 123 /n /m "请输入选项 [1/2/3]: "
set "BRAND_ARG=--brand-title english"
if errorlevel 3 set "BRAND_ARG=--brand-title translated"
if errorlevel 2 if not errorlevel 3 set "BRAND_ARG=--brand-title hidden"

echo.
echo [安装] 正在执行结构探测、哈希备份与安全替换...
"%NODE_CMD%" "%~dp0installer.js" %BRAND_ARG% %*
if errorlevel 1 goto FAIL

echo.
echo [完成] 汉化已安全部署。
echo.
pause
exit /b 0

:FAIL
echo.
echo [失败] 安装器已安全停止，未验证的修改不会覆盖客户端。
echo.
pause
exit /b 1
