from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime
import os

Base = declarative_base()

DATABASE_URL = "sqlite:///" + os.path.join(os.path.dirname(__file__), "reminders.db")
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

class Reminder(Base):
    __tablename__ = "reminders"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(200), nullable=False)
    content = Column(Text, nullable=True)
    category = Column(String(50), nullable=False, default="task")  # group, task, homework
    reminder_type = Column(String(20), nullable=False, default="once")  # once, daily, weekly, custom
    cron_expression = Column(String(100), nullable=True)
    remind_at = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True)
    sound_enabled = Column(Boolean, default=True)
    push_enabled = Column(Boolean, default=True)
    webhook_url = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)
    last_triggered = Column(DateTime, nullable=True)
    trigger_count = Column(Integer, default=0)

class Category(Base):
    __tablename__ = "categories"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(50), nullable=False)
    color = Column(String(20), default="#378ADD")
    icon = Column(String(50), default="bell")
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.now)

class Settings(Base):
    __tablename__ = "settings"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String(50), nullable=False, unique=True)
    value = Column(String(500), nullable=True)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

# 初始化数据库
Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
