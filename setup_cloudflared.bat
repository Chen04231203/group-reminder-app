@echo off
chcp 65001 >nul

echo ============================================
echo     内网穿透 - 生成公开访问链接
echo ============================================
echo.
echo 这个功能可以让你和女朋友在任何地方
echo（不需要同一WiFi）都能访问提醒助手。
echo.
echo 正在下载 Cloudflare Tunnel 工具...
echo.

set "CF_DIR=%~dp0cloudflared"
if not exist "%CF_DIR%" mkdir "%CF_DIR%"

:: 检查是否已下载
if exist "%CF_DIR%\cloudflared.exe" (
    echo 工具已存在，直接启动...
    goto start_tunnel
)

:: 下载 cloudflared
echo 正在下载（约 8MB）...
curl -L -o "%CF_DIR%\cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" 2>nul

if not exist "%CF_DIR%\cloudflared.exe" (
    echo.
    echo [错误] 下载失败，请检查网络连接。
    echo 备用方案：使用 start_enhanced.bat 在同一WiFi下访问。
    pause
    exit /b 1
)

echo 下载完成！

:start_tunnel
echo.
echo ============================================
echo  正在创建公开隧道...
echo  首次使用需要按提示完成认证（只需一次）
echo ============================================
echo.

"%CF_DIR%\cloudflared.exe" tunnel --url http://localhost:8000

echo.
echo 隧道已关闭。
pause
