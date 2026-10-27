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
import os
import json
import asyncio
import httpx

from models import Reminder, Category, Settings, get_db, SessionLocal
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

# 静态文件
frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/static", StaticFiles(directory=frontend_path), name="static")

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
