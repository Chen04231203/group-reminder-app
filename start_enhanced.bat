@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo ============================================
echo     群通知提醒助手 - 一键启动
echo ============================================
echo.

:: 获取管理员权限（如需修改防火墙）
>nul 2>&1 "%SYSTEMROOT%\system32\cacls.exe" "%SYSTEMROOT%\system32\config\system"
if '%errorlevel%' NEQ '0' (
    echo 正在获取管理员权限...
    goto UACPrompt
) else (
    goto gotAdmin
)

:UACPrompt
    echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\getadmin.vbs"
    echo UAC.ShellExecute "%~s0", "", "", "runas", 1 >> "%temp%\getadmin.vbs"
    "%temp%\getadmin.vbs"
    exit /b

:gotAdmin
    if exist "%temp%\getadmin.vbs" ( del "%temp%\getadmin.vbs" )

:: 设置路径
set "SCRIPT_DIR=%~dp0"
set "BACKEND_DIR=%SCRIPT_DIR%backend"
set "PYTHON=%BACKEND_DIR%\venv\Scripts\python.exe"
set "PIP=%BACKEND_DIR%\venv\Scripts\pip.exe"

cd /d "%BACKEND_DIR%"

:: 检查虚拟环境
if not exist "%PYTHON%" (
    echo [1/5] 首次运行，创建虚拟环境...
    C:\Users\Chen0423\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe -m venv venv
    echo [2/5] 安装依赖中，请稍等...
    "%PIP%" install -q fastapi uvicorn sqlalchemy aiosqlite apscheduler pydantic python-multipart httpx 2>nul
    if !errorlevel! neq 0 (
        echo    正在安装依赖...
        "%PIP%" install fastapi uvicorn sqlalchemy aiosqlite apscheduler pydantic python-multipart httpx
    )
) else (
    echo [1/5] 环境已就绪
)

:: 开放防火墙端口
echo [2/5] 配置网络访问...
netsh advfirewall firewall show rule name="ReminderApp-8000" >nul 2>&1
if !errorlevel! neq 0 (
    netsh advfirewall firewall add rule name="ReminderApp-8000" dir=in action=allow protocol=tcp localport=8000 >nul 2>&1
    echo    已开放 8000 端口，手机可访问
) else (
    echo    端口已开放
)

:: 获取局域网 IP
for /f "tokens=2 delims=[]" %%a in ('ping -4 -n 1 %computername% ^| findstr "["') do set "LOCAL_IP=%%a"
if not defined LOCAL_IP (
    for /f "tokens=14" %%a in ('ipconfig ^| findstr /i "IPv4"') do set "LOCAL_IP=%%a"
)

:: 启动后端服务
echo [3/5] 启动服务...
start /min "ReminderApp-Backend" cmd /c "cd /d "%BACKEND_DIR%" && "%PYTHON%" main.py"

:: 等待服务启动
timeout /t 3 /nobreak >nul

:: 检查服务是否启动
curl -s http://localhost:8000/api/stats >nul 2>&1
if !errorlevel! neq 0 (
    timeout /t 2 /nobreak >nul
    curl -s http://localhost:8000/api/stats >nul 2>&1
)

echo [4/5] 服务已启动！
echo.
echo ============================================
echo              访问地址
echo ============================================
echo.
echo  电脑访问：http://localhost:8000
echo.
if defined LOCAL_IP (
echo  手机访问：http://%LOCAL_IP%:8000
echo.
echo  手机扫码：用微信/浏览器扫描下方二维码
echo.
) else (
echo  手机访问：请查看电脑IP后访问 http://[电脑IP]:8000
echo.
)

:: 生成二维码图片（如果 qrcode 可用）
"%PYTHON%" -c "import qrcode" 2>nul
if !errorlevel! neq 0 (
    "%PIP%" install -q qrcode pillow 2>nul
)

if defined LOCAL_IP (
    "%PYTHON%" -c "
import qrcode, os
ip = os.environ.get('LOCAL_IP', 'localhost')
url = f'http://{ip}:8000'
qr = qrcode.QRCode(version=1, box_size=6, border=2)
qr.add_data(url)
qr.make(fit=True)
img = qr.make_image(fill_color='#534AB7', back_color='white')
img.save(r'%SCRIPT_DIR%qrcode.png')
print(f'二维码已保存: {url}')
" 2>nul
    
    if exist "%SCRIPT_DIR%qrcode.png" (
        start "" "%SCRIPT_DIR%qrcode.png"
    )
)

:: 打开浏览器
echo [5/5] 正在打开浏览器...
start http://localhost:8000

echo.
echo ============================================
echo  服务运行中，请勿关闭此窗口！
echo  按 Ctrl+C 或关闭窗口停止服务
echo ============================================
echo.

:: 保持窗口打开
cd /d "%SCRIPT_DIR%"
:loop
timeout /t 30 /nobreak >nul
curl -s http://localhost:8000/api/stats >nul 2>&1
if !errorlevel! neq 0 (
    echo [警告] 服务似乎已停止，正在重启...
    start /min "ReminderApp-Backend" cmd /c "cd /d "%BACKEND_DIR%" && "%PYTHON%" main.py"
    timeout /t 3 /nobreak >nul
)
goto loop
