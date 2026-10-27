#!/bin/bash
echo "========================================"
echo "    群通知提醒助手 - 启动脚本"
echo "========================================"
echo ""

BACKEND_DIR="$(cd "$(dirname "$0")/backend" && pwd)"

echo "[1/3] 检查依赖..."
cd "$BACKEND_DIR"
pip install -q fastapi uvicorn sqlalchemy aiosqlite apscheduler pydantic python-multipart 2>/dev/null || \
    pip install fastapi uvicorn sqlalchemy aiosqlite apscheduler pydantic python-multipart

echo "[2/3] 启动后端服务..."
echo "    地址: http://localhost:8000"
echo "    按 Ctrl+C 停止服务"
echo ""
echo "========================================"
echo ""

python main.py
