from pydantic import BaseModel
from datetime import datetime
from typing import Optional

class ReminderCreate(BaseModel):
    title: str
    content: Optional[str] = ""
    category: str = "task"
    reminder_type: str = "once"
    cron_expression: Optional[str] = None
    remind_at: Optional[datetime] = None
    sound_enabled: bool = True
    push_enabled: bool = True
    webhook_url: Optional[str] = None

class ReminderUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    category: Optional[str] = None
    reminder_type: Optional[str] = None
    cron_expression: Optional[str] = None
    remind_at: Optional[datetime] = None
    is_active: Optional[bool] = None
    sound_enabled: Optional[bool] = None
    push_enabled: Optional[bool] = None
    webhook_url: Optional[str] = None

class ReminderResponse(BaseModel):
    id: int
    title: str
    content: Optional[str]
    category: str
    reminder_type: str
    cron_expression: Optional[str]
    remind_at: Optional[datetime]
    is_active: bool
    sound_enabled: bool
    push_enabled: bool
    webhook_url: Optional[str]
    created_at: datetime
    updated_at: datetime
    last_triggered: Optional[datetime]
    trigger_count: int

    class Config:
        from_attributes = True

class CategoryCreate(BaseModel):
    name: str
    color: Optional[str] = "#378ADD"
    icon: Optional[str] = "bell"
    sort_order: Optional[int] = 0

class CategoryResponse(BaseModel):
    id: int
    name: str
    color: str
    icon: str
    sort_order: int
    created_at: datetime

    class Config:
        from_attributes = True
