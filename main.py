from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import desc
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from datetime import datetime, timedelta
from typing import Optional
from urllib.parse import urlparse
import os
import json
import re
import asyncio
import httpx

from models import (Reminder, Category, Settings, PushSubscription,
                    get_db, SessionLocal)
from schemas import ReminderCreate, ReminderUpdate, ReminderResponse, CategoryCreate, CategoryResponse
from nlp_parser import parse_reminder

app = FastAPI(title="群通知提醒系统", version="1.0.0")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 静态文件 - 兼容本地和 Render 部署路径
_base_dir = os.path.dirname(__file__)
_frontend_paths = [
    os.path.join(_base_dir, "..", "frontend"),      # 本地: backend/../frontend
    os.path.join(_base_dir, "frontend"),            # 同级: backend/frontend
    os.path.join(_base_dir, "..", "..", "frontend"),# 更上级
    os.path.join(os.getcwd(), "frontend"),          # 当前工作目录/frontend
    os.getcwd(),                                    # 当前目录本身（Render平铺）
]
frontend_path = None
for p in _frontend_paths:
    p = os.path.abspath(p)
    if os.path.exists(p) and os.path.isdir(p):
        # 检查是否有前端文件
        if os.path.exists(os.path.join(p, "index.html")) or os.path.exists(os.path.join(p, "app.js")):
            frontend_path = p
            break

if not frontend_path:
    # 兜底：用第一个路径，即使不存在
    frontend_path = os.path.abspath(os.path.join(_base_dir, "..", "frontend"))
    print(f"Warning: frontend directory not found, using {frontend_path}")

app.mount("/static", StaticFiles(directory=frontend_path), name="static")

# ========== Web Push（浏览器系统推送，关掉网页也能收到） ==========
# VAPID 密钥固定写死，保证 Render 重启后已订阅的设备依然有效。
# 如需更换，在 Render 环境变量里设置 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 即可覆盖。
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "BP8hSKyH1485IOEmk3iAxVb6vKQQc1lAuoZVu89Gc-_xyUD7ek0eS-aGTUlGsT6Lk7CBPNC7dyIS5P_j_ztSXyc")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", """-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg8m+TKEyllizxcgP4
qvEgQexl0HIwLuR3+nhuoy0CBNehRANCAAT/IUish9ePOSDhJpN4gMVW+rykEHNZ
QLqGVbvPRnPv8clA+3pNHkvmhk1JRrE+i5OwgTzQu3ciEuT/4/87Ul8n
-----END PRIVATE KEY-----""")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:reminder@example.com")


def _normalize_vapid_key(key: str) -> str:
    """py_vapid 只认纯 base64 DER，这里兼容 PEM 格式（带 -----BEGIN----- 头尾）输入"""
    key = (key or "").strip()
    if "BEGIN" in key:
        key = "".join(l for l in key.splitlines() if l and "-----" not in l)
    return key.replace("\n", "").replace("\r", "").strip()


VAPID_PRIVATE_KEY = _normalize_vapid_key(VAPID_PRIVATE_KEY)


def _push_payload(title: str, content: str, category: str, reminder_id: int) -> str:
    return json.dumps({
        "title": title,
        "content": content or "",
        "category": category,
        "id": reminder_id,
        "timestamp": datetime.now().isoformat(),
    }, ensure_ascii=False)


def send_web_push(title: str, content: str, category: str, reminder_id: int) -> int:
    """向所有已订阅设备发送系统推送，返回成功条数。阻塞函数，请用 to_thread 调用。"""
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        print("未安装 pywebpush，跳过 Web Push")
        return 0

    db = SessionLocal()
    sent = 0
    try:
        subs = db.query(PushSubscription).all()
        if not subs:
            return 0

        payload = _push_payload(title, content, category, reminder_id)

        for sub in subs:
            try:
                origin = "{0.scheme}://{0.netloc}".format(urlparse(sub.endpoint))
                webpush(
                    subscription_info={
                        "endpoint": sub.endpoint,
                        "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                    },
                    data=payload,
                    vapid_private_key=VAPID_PRIVATE_KEY,
                    vapid_claims={"sub": VAPID_SUBJECT, "aud": origin},
                    ttl=86400,
                )
                sub.last_ok = datetime.now()
                sub.fail_count = 0
                sent += 1
            except WebPushException as e:
                code = getattr(getattr(e, "response", None), "status_code", None)
                if code in (404, 410):
                    # 订阅已失效（用户卸载/清缓存），直接清理
                    db.delete(sub)
                    print(f"Web Push 订阅失效，已清理: {code}")
                else:
                    sub.fail_count = (sub.fail_count or 0) + 1
                    print(f"Web Push 失败 [{code}]: {e}")
            except Exception as e:
                print(f"Web Push 异常: {e}")
        db.commit()
    finally:
        db.close()
    return sent


# ========== 微信推送（PushPlus）国内安卓主力通道 ==========
PUSHPLUS_API = "https://www.pushplus.plus/send"


def _get_setting(db, key: str, default=None):
    s = db.query(Settings).filter(Settings.key == key).first()
    return s.value if s and s.value not in (None, "") else default


def _set_setting(db, key: str, value: str):
    s = db.query(Settings).filter(Settings.key == key).first()
    if s:
        s.value = value
    else:
        db.add(Settings(key=key, value=value))
    db.commit()


def _split_tokens(raw: str):
    """支持一个字段填多个 token（逗号/空格/换行分隔），两个人各收各的"""
    if not raw:
        return []
    return [t for t in re.split(r"[,，;；\s]+", raw) if t]


def send_pushplus(token: str, title: str, content: str):
    """通过 PushPlus 推到微信，返回 (是否成功, 提示文字)"""
    if not token:
        return False, "未配置 PushPlus Token"
    try:
        r = httpx.post(PUSHPLUS_API, json={
            "token": token,
            "title": title,
            "content": content or title,
            "template": "txt",
        }, timeout=15)
        data = r.json()
        code = data.get("code")
        if code == 200:
            return True, "发送成功"
        # 常见错误码翻译成人话
        tips = {
            900: "今天的推送次数用完了，明天凌晨恢复",
            903: "Token 无效，请检查是否复制完整",
            905: "账号未实名认证，需先在 PushPlus 公众号完成实名",
        }
        return False, tips.get(code, f"PushPlus 返回：{data.get('msg') or data}")
    except Exception as e:
        return False, f"请求失败：{e}"


# ========== 企业微信群机器人（免费、无条数限制、国内稳定） ==========


def send_wecom(webhook: str, title: str, content: str):
    """推送到企业微信群机器人，返回 (是否成功, 提示文字)"""
    if not webhook:
        return False, "未配置企业微信 Webhook"
    if "qyapi.weixin.qq.com" not in webhook:
        return False, "这不是企业微信机器人地址，请检查是否复制完整"

    try:
        md = (f"## {title}\n"
              f"{content or ''}\n"
              f"> {datetime.now().strftime('%Y-%m-%d %H:%M')}")
        r = httpx.post(webhook, json={
            "msgtype": "markdown",
            "markdown": {"content": md},
        }, timeout=15)
        data = r.json()
        if data.get("errcode") == 0:
            return True, "发送成功"

        code = data.get("errcode")
        tips = {
            93000: "Webhook 地址无效，请重新复制",
            45009: "发送太频繁了，企业微信限制每分钟 20 条",
        }
        return False, tips.get(code, f"企业微信返回：{data.get('errmsg')}（{code}）")
    except Exception as e:
        return False, f"请求失败：{e}"


# ========== 定时任务调度器 ==========
scheduler = BackgroundScheduler()
scheduler.start()

# 存储 WebSocket 连接（用于实时推送）
connected_clients = []

# 触发提醒
async def trigger_reminder(reminder_id: int):
    db = SessionLocal()
    try:
        reminder = db.query(Reminder).filter(Reminder.id == reminder_id).first()
        if not reminder or not reminder.is_active:
            return
        
        reminder.last_triggered = datetime.now()
        reminder.trigger_count += 1
        db.commit()
        
        # 检查全局声音设置
        global_sound = db.query(Settings).filter(Settings.key == "global_sound").first()
        global_sound_on = global_sound.value != "false" if global_sound else True
        
        # 发送到 WebSocket 客户端
        payload = {
            "type": "reminder_triggered",
            "data": {
                "id": reminder.id,
                "title": reminder.title,
                "content": reminder.content,
                "category": reminder.category,
                "sound_enabled": reminder.sound_enabled and global_sound_on,
                "push_enabled": reminder.push_enabled,
                "timestamp": datetime.now().isoformat()
            }
        }
        
        # 推送到所有连接的客户端
        for client in connected_clients:
            try:
                await client.send_json(payload)
            except:
                pass

        # 浏览器系统推送（网页关掉也能收到，这是给"懒人"的主力通道）
        if reminder.push_enabled:
            try:
                n = await asyncio.to_thread(
                    send_web_push,
                    reminder.title,
                    reminder.content or "",
                    reminder.category,
                    reminder.id,
                )
                if n:
                    print(f"Web Push 已发送 {n} 台设备")
            except Exception as e:
                print(f"Web Push 调度失败: {e}")

        # 微信推送（PushPlus）—— 国内安卓的主力通道，不依赖任何手机设置
        if reminder.push_enabled:
            try:
                tokens = _split_tokens(_get_setting(db, "pushplus_token"))
                for tk in tokens:
                    ok, msg = await asyncio.to_thread(
                        send_pushplus, tk, reminder.title,
                        reminder.content or reminder.title,
                    )
                    print(f"PushPlus 微信推送[{tk[:6]}]: {'成功' if ok else msg}")
            except Exception as e:
                print(f"PushPlus 调度失败: {e}")

        # 企业微信群机器人（全局配置，所有提醒共用同一个群）
        if reminder.push_enabled:
            try:
                hook = _get_setting(db, "wecom_webhook")
                if hook:
                    ok, msg = await asyncio.to_thread(
                        send_wecom, hook, reminder.title, reminder.content or "")
                    print(f"企业微信推送: {'成功' if ok else msg}")
            except Exception as e:
                print(f"企业微信调度失败: {e}")


        # Webhook 推送（企业微信等）
        if reminder.webhook_url:
            async with httpx.AsyncClient() as client:
                try:
                    msg = f"【{reminder.title}】\n{reminder.content or ''}"
                    await client.post(reminder.webhook_url, json={"msgtype": "text", "text": {"content": msg}}, timeout=10)
                except Exception as e:
                    print(f"Webhook 发送失败: {e}")
    finally:
        db.close()

def schedule_reminder(reminder: Reminder):
    job_id = f"reminder_{reminder.id}"
    # 移除旧任务
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
    
    if not reminder.is_active:
        return
    
    if reminder.reminder_type == "once" and reminder.remind_at:
        if reminder.remind_at > datetime.now():
            scheduler.add_job(
                lambda rid=reminder.id: asyncio.create_task(trigger_reminder(rid)),
                'date',
                run_date=reminder.remind_at,
                id=job_id,
                replace_existing=True
            )
    elif reminder.reminder_type == "daily" and reminder.remind_at:
        scheduler.add_job(
            lambda rid=reminder.id: asyncio.create_task(trigger_reminder(rid)),
            'cron',
            hour=reminder.remind_at.hour,
            minute=reminder.remind_at.minute,
            id=job_id,
            replace_existing=True
        )
    elif reminder.reminder_type == "weekly" and reminder.remind_at:
        scheduler.add_job(
            lambda rid=reminder.id: asyncio.create_task(trigger_reminder(rid)),
            'cron',
            day_of_week=reminder.remind_at.weekday(),
            hour=reminder.remind_at.hour,
            minute=reminder.remind_at.minute,
            id=job_id,
            replace_existing=True
        )
    elif reminder.reminder_type == "custom" and reminder.cron_expression:
        try:
            parts = reminder.cron_expression.split()
            if len(parts) == 5:
                trigger = CronTrigger(
                    minute=parts[0],
                    hour=parts[1],
                    day=parts[2],
                    month=parts[3],
                    day_of_week=parts[4]
                )
                scheduler.add_job(
                    lambda rid=reminder.id: asyncio.create_task(trigger_reminder(rid)),
                    trigger,
                    id=job_id,
                    replace_existing=True
                )
        except Exception as e:
            print(f"Cron 表达式解析失败: {e}")

# 启动时加载所有活跃的提醒任务
@app.on_event("startup")
async def load_schedules():
    db = SessionLocal()
    try:
        reminders = db.query(Reminder).filter(Reminder.is_active == True).all()
        for r in reminders:
            schedule_reminder(r)
        print(f"已加载 {len(reminders)} 个提醒任务")
    finally:
        db.close()

# ========== API 路由 ==========

@app.get("/")
async def root():
    return FileResponse(os.path.join(frontend_path, "index.html"))


@app.get("/sw.js")
async def service_worker():
    """Service Worker 必须从根路径提供，作用域才能覆盖整站（否则只能控制 /static/）"""
    return FileResponse(
        os.path.join(frontend_path, "sw.js"),
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )

# ---- AI 智能解析 ----

class ParseRequest(BaseModel):
    text: str

@app.post("/api/parse")
def parse_text(data: ParseRequest):
    """AI 智能解析自然语言，提取提醒信息"""
    if not data.text or not data.text.strip():
        raise HTTPException(status_code=400, detail="消息内容不能为空")
    
    result = parse_reminder(data.text.strip())
    return result

# ---- 提醒管理 ----

@app.get("/api/reminders", response_model=list[ReminderResponse])
def get_reminders(category: str = None, db: Session = Depends(get_db)):
    query = db.query(Reminder).order_by(desc(Reminder.created_at))
    if category:
        query = query.filter(Reminder.category == category)
    return query.all()

@app.get("/api/reminders/{reminder_id}", response_model=ReminderResponse)
def get_reminder(reminder_id: int, db: Session = Depends(get_db)):
    r = db.query(Reminder).filter(Reminder.id == reminder_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="提醒不存在")
    return r

@app.post("/api/reminders", response_model=ReminderResponse)
def create_reminder(data: ReminderCreate, db: Session = Depends(get_db)):
    reminder = Reminder(**data.model_dump())
    db.add(reminder)
    db.commit()
    db.refresh(reminder)
    schedule_reminder(reminder)
    return reminder

@app.put("/api/reminders/{reminder_id}", response_model=ReminderResponse)
def update_reminder(reminder_id: int, data: ReminderUpdate, db: Session = Depends(get_db)):
    reminder = db.query(Reminder).filter(Reminder.id == reminder_id).first()
    if not reminder:
        raise HTTPException(status_code=404, detail="提醒不存在")
    
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(reminder, key, value)
    
    reminder.updated_at = datetime.now()
    db.commit()
    db.refresh(reminder)
    schedule_reminder(reminder)
    return reminder

@app.delete("/api/reminders/{reminder_id}")
def delete_reminder(reminder_id: int, db: Session = Depends(get_db)):
    reminder = db.query(Reminder).filter(Reminder.id == reminder_id).first()
    if not reminder:
        raise HTTPException(status_code=404, detail="提醒不存在")
    
    job_id = f"reminder_{reminder_id}"
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)
    
    db.delete(reminder)
    db.commit()
    return {"message": "删除成功"}

@app.post("/api/reminders/{reminder_id}/trigger")
def manual_trigger(reminder_id: int, db: Session = Depends(get_db)):
    reminder = db.query(Reminder).filter(Reminder.id == reminder_id).first()
    if not reminder:
        raise HTTPException(status_code=404, detail="提醒不存在")
    
    asyncio.create_task(trigger_reminder(reminder_id))
    return {"message": "已触发", "reminder": ReminderResponse.model_validate(reminder)}

# ---- 分类管理 ----

@app.get("/api/categories", response_model=list[CategoryResponse])
def get_categories(db: Session = Depends(get_db)):
    return db.query(Category).order_by(Category.sort_order).all()

@app.post("/api/categories", response_model=CategoryResponse)
def create_category(data: CategoryCreate, db: Session = Depends(get_db)):
    cat = Category(**data.model_dump())
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat

@app.delete("/api/categories/{cat_id}")
def delete_category(cat_id: int, db: Session = Depends(get_db)):
    cat = db.query(Category).filter(Category.id == cat_id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="分类不存在")
    db.delete(cat)
    db.commit()
    return {"message": "删除成功"}

# ---- 统计 ----

@app.get("/api/stats")
def get_stats(db: Session = Depends(get_db)):
    total = db.query(Reminder).count()
    active = db.query(Reminder).filter(Reminder.is_active == True).count()
    group = db.query(Reminder).filter(Reminder.category == "group").count()
    task = db.query(Reminder).filter(Reminder.category == "task").count()
    homework = db.query(Reminder).filter(Reminder.category == "homework").count()
    today = db.query(Reminder).filter(
        Reminder.remind_at >= datetime.now().replace(hour=0, minute=0, second=0),
        Reminder.remind_at < datetime.now().replace(hour=0, minute=0, second=0) + timedelta(days=1)
    ).count()
    
    return {
        "total": total,
        "active": active,
        "group": group,
        "task": task,
        "homework": homework,
        "today": today
    }

# ---- 设置管理 ----

class SettingsUpdate(BaseModel):
    global_sound: Optional[bool] = None

@app.get("/api/settings")
def get_settings(db: Session = Depends(get_db)):
    settings = db.query(Settings).all()
    result = {}
    for s in settings:
        # 敏感配置不通过这个接口返回
        if s.key in ("pushplus_token", "smtp_pass", "wecom_webhook"):
            continue
        if s.value == "true":
            result[s.key] = True
        elif s.value == "false":
            result[s.key] = False
        else:
            result[s.key] = s.value
    return result

@app.put("/api/settings")
def update_settings(data: SettingsUpdate, db: Session = Depends(get_db)):
    if data.global_sound is not None:
        setting = db.query(Settings).filter(Settings.key == "global_sound").first()
        if setting:
            setting.value = "true" if data.global_sound else "false"
        else:
            setting = Settings(key="global_sound", value="true" if data.global_sound else "false")
            db.add(setting)
        db.commit()
    return {"message": "设置已更新"}

# ---- 推送渠道配置（PushPlus 微信推送） ----

class ChannelUpdate(BaseModel):
    pushplus_token: Optional[str] = None
    wecom_webhook: Optional[str] = None


class ChannelTestIn(BaseModel):
    channel: Optional[str] = "all"   # pushplus / email / all


@app.get("/api/channels")
def get_channels(db: Session = Depends(get_db)):
    token = _get_setting(db, "pushplus_token", "") or ""
    hint = ""
    if token:
        hint = (token[:4] + "****" + token[-4:]) if len(token) > 10 else "已设置"

    hook = _get_setting(db, "wecom_webhook", "") or ""
    hook_hint = ""
    if hook:
        # 只露出末尾 key 的一小段，避免完整地址外泄
        hook_hint = "…" + hook[-12:] if len(hook) > 12 else "已设置"

    return {
        "pushplus_set": bool(token),
        "pushplus_hint": hint,
        "wecom_set": bool(hook),
        "wecom_hint": hook_hint,
    }


@app.put("/api/channels")
def update_channels(data: ChannelUpdate, db: Session = Depends(get_db)):
    # 传空字符串表示"不修改"，避免前端拿不到原值时把配置清掉
    if data.pushplus_token is not None and data.pushplus_token.strip():
        _set_setting(db, "pushplus_token", data.pushplus_token.strip())
    if data.wecom_webhook is not None and data.wecom_webhook.strip():
        hook = data.wecom_webhook.strip()
        if "qyapi.weixin.qq.com" not in hook:
            raise HTTPException(
                status_code=400,
                detail="这不是企业微信机器人地址，请检查是否复制完整")
        _set_setting(db, "wecom_webhook", hook)
    return {"message": "已保存"}


@app.post("/api/channels/test")
async def test_channel(data: ChannelTestIn = None, db: Session = Depends(get_db)):
    channel = (data.channel if data and data.channel else "all")
    stamp = datetime.now().strftime("%H:%M:%S")
    results = []

    # --- PushPlus 微信 ---
    if channel in ("all", "pushplus"):
        tokens = _split_tokens(_get_setting(db, "pushplus_token"))
        if tokens:
            ok_count, errors = 0, []
            for tk in tokens:
                # 内容带时间戳，避免触发「相同内容 1 小时最多 3 条」限制
                ok, msg = await asyncio.to_thread(
                    send_pushplus, tk, "测试推送 ✅",
                    f"看到这条微信消息，就说明提醒能正常推到微信了！\n发送时间：{stamp}")
                if ok:
                    ok_count += 1
                else:
                    errors.append(msg)
            if ok_count:
                extra = f"，{len(errors)} 个失败：{errors[0]}" if errors else ""
                results.append(("ok", f"微信已发到 {ok_count}/{len(tokens)} 个{extra}"))
            else:
                results.append(("fail", errors[0] if errors else "微信发送失败"))

    # --- 企业微信群机器人 ---
    if channel in ("all", "wecom"):
        hook = _get_setting(db, "wecom_webhook")
        if hook:
            ok, msg = await asyncio.to_thread(
                send_wecom, hook, "测试提醒 ✅",
                f"看到这条群消息，就说明企业微信推送已经通了。\n发送时间：{stamp}")
            results.append(("ok" if ok else "fail",
                            "企业微信群已收到测试消息" if ok else f"企业微信：{msg}"))
        elif channel == "wecom":
            results.append(("fail", "还没填企业微信 Webhook 地址"))

    if not results:
        return {"ok": False, "message": "还没有配置任何推送渠道"}

    fails = [m for st, m in results if st == "fail"]
    oks = [m for st, m in results if st == "ok"]
    if oks:
        return {"ok": True, "message": "；".join(oks) + ("；失败：" + fails[0] if fails else "")}
    return {"ok": False, "message": fails[0]}


# ---- Web Push 订阅管理 ----

class PushSubIn(BaseModel):
    endpoint: str
    keys: dict
    device: Optional[str] = None

class PushUnsubIn(BaseModel):
    endpoint: str

@app.get("/api/push/vapid-public-key")
def get_vapid_public_key():
    """前端订阅时需要公钥"""
    return {"publicKey": VAPID_PUBLIC_KEY}

@app.post("/api/push/subscribe")
def subscribe_push(data: PushSubIn, db: Session = Depends(get_db)):
    p256dh = data.keys.get("p256dh")
    auth = data.keys.get("auth")
    if not (data.endpoint and p256dh and auth):
        raise HTTPException(status_code=400, detail="订阅信息不完整")

    sub = db.query(PushSubscription).filter(
        PushSubscription.endpoint == data.endpoint).first()
    if sub:
        sub.p256dh = p256dh
        sub.auth = auth
        sub.device = data.device or sub.device
        sub.fail_count = 0
    else:
        db.add(PushSubscription(
            endpoint=data.endpoint, p256dh=p256dh, auth=auth,
            device=data.device,
        ))
    db.commit()
    return {"message": "订阅成功", "count": db.query(PushSubscription).count()}

@app.post("/api/push/unsubscribe")
def unsubscribe_push(data: PushUnsubIn, db: Session = Depends(get_db)):
    db.query(PushSubscription).filter(
        PushSubscription.endpoint == data.endpoint).delete()
    db.commit()
    return {"message": "已取消订阅", "count": db.query(PushSubscription).count()}

@app.get("/api/push/status")
def push_status(db: Session = Depends(get_db)):
    subs = db.query(PushSubscription).all()
    return {
        "count": len(subs),
        "devices": [{
            "device": s.device or "未知设备",
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "last_ok": s.last_ok.isoformat() if s.last_ok else None,
        } for s in subs],
    }

@app.post("/api/push/test")
async def push_test(db: Session = Depends(get_db)):
    """发一条测试推送，验证手机/电脑能不能收到"""
    total = db.query(PushSubscription).count()
    if total == 0:
        return {"sent": 0, "total": 0,
                "message": "还没有设备订阅，请先点「开启系统推送」"}

    n = await asyncio.to_thread(
        send_web_push, "测试推送 ✅",
        "看到这条通知就说明系统推送已生效，网页关掉也能收到啦！", "task", 0)

    if n:
        msg = f"已发送到 {n}/{total} 台设备，去看看通知栏"
    else:
        msg = f"{total} 台设备都没发出去，请查看 Render 日志"
    return {"sent": n, "total": total, "message": msg}

@app.get("/api/health")
def health_check():
    """给 UptimeRobot 之类的保活服务用，防止 Render 免费版休眠"""
    db = SessionLocal()
    try:
        return {
            "status": "ok",
            "time": datetime.now().isoformat(),
            "reminders": db.query(Reminder).count(),
            "push_devices": db.query(PushSubscription).count(),
        }
    finally:
        db.close()

# ---- WebSocket (实时推送) ----

from fastapi import WebSocket

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.append(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            # 客户端心跳保活
            if data == "ping":
                await websocket.send_text("pong")
    except:
        pass
    finally:
        if websocket in connected_clients:
            connected_clients.remove(websocket)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
