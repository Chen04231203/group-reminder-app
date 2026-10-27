@echo off
chcp 65001 >nul
echo ========================================
echo     群通知提醒助手 - 启动脚本
echo ========================================
echo.

set PYTHON=C:\Users\Chen0423\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe
set BACKEND_DIR=%~dp0backend

if not exist "%PYTHON%" (
    echo [错误] 未找到 Python，请检查路径
    pause
    exit /b 1
)

echo [1/3] 检查依赖...
cd /d "%BACKEND_DIR%"

"%PYTHON%" -m pip install -q fastapi uvicorn sqlalchemy aiosqlite apscheduler pydantic python-multipart 2>nul
if %errorlevel% neq 0 (
    echo    尝试安装依赖...
    "%PYTHON%" -m pip install fastapi uvicorn sqlalchemy aiosqlite apscheduler pydantic python-multipart
)

echo [2/3] 启动后端服务...
echo    地址: http://localhost:8000
echo    按 Ctrl+C 停止服务
echo.
echo ========================================
echo.

"%PYTHON%" main.py
