@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Antigravity 汉化安全还原工具

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
    echo [错误] 未检测到 Node.js 运行环境。
    pause
    exit /b 1
)

echo.
echo [还原] 正在校验关联备份并安全还原官方包...
"%NODE_CMD%" "%~dp0installer.js" --restore %*
if errorlevel 1 goto FAIL

echo.
echo [完成] 已恢复经过哈希校验的官方包。
echo.
pause
exit /b 0

:FAIL
echo.
echo [失败] 未找到可信备份或校验失败，客户端不会被陈旧备份覆盖。
echo.
pause
exit /b 1
