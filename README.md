# 群通知提醒助手

一个支持 **群通知、任务提醒、作业提醒** 的 Web PWA 应用。手机电脑都能用，一键复制提醒内容到微信群。

## 功能特性

| 功能 | 说明 |
|---|---|
| 群通知管理 | 管理微信群通知内容，支持一键复制粘贴 |
| 任务提醒 | 定时提醒工作任务，支持每天/每周重复 |
| 作业提醒 | 学生作业截止提醒，支持自定义 cron 规则 |
| 多端同步 | 手机 + 电脑浏览器打开即用，PWA 支持离线 |
| 推送通知 | 浏览器推送 + 系统弹窗 + 声音提醒 |
| 企业微信 | 可选配置 Webhook 自动推送到企微群 |
| 实时同步 | WebSocket 实时推送，无需刷新页面 |

## 快速开始

### Windows

双击运行 `start.bat`

### macOS / Linux

```bash
chmod +x start.sh
./start.sh
```

### 手动启动

```bash
cd backend
pip install -r requirements.txt
python main.py
```

然后打开浏览器访问：**http://localhost:8000**

## 手机使用

1. 确保手机和电脑在同一 WiFi 下
2. 电脑上 `Win+R` 输入 `cmd`，执行 `ipconfig` 查看局域网 IP
3. 手机浏览器访问 `http://<电脑IP>:8000`
4. 点击浏览器菜单 → "添加到主屏幕"，即可像 App 一样使用

## 技术栈

- **后端**：Python FastAPI + SQLite + APScheduler
- **前端**：HTML/CSS/JS PWA（无需构建工具）
- **实时通信**：WebSocket

## 目录结构

```
group-reminder-app/
├── backend/
│   ├── main.py          # FastAPI 主程序
│   ├── models.py        # 数据库模型
│   ├── schemas.py       # 数据校验
│   └── requirements.txt # Python 依赖
├── frontend/
│   ├── index.html       # 主页面
│   ├── style.css        # 样式
│   ├── app.js           # 前端逻辑
│   ├── manifest.json    # PWA 配置
│   └── sw.js            # Service Worker
├── start.bat            # Windows 启动脚本
├── start.sh             # Linux/macOS 启动脚本
└── README.md
```

## Cron 表达式参考

| 表达式 | 含义 |
|---|---|
| `0 9 * * 1-5` | 工作日每天 9:00 |
| `0 8 * * 1` | 每周一 8:00 |
| `0 0 1 * *` | 每月 1 号 0:00 |
| `*/30 * * * *` | 每 30 分钟 |

格式：`分 时 日 月 周`（5段，空格分隔）
