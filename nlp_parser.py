"""
自然语言提醒解析器
把微信消息/自然语言解析成结构化的提醒数据
"""
import re
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

class ReminderParser:
    """解析自然语言中的时间、事件类型和内容"""
    
    # 星期映射
    WEEKDAY_MAP = {
        '一': 0, '1': 0, '周一': 0, '星期一': 0,
        '二': 1, '2': 1, '周二': 1, '星期二': 1,
        '三': 2, '3': 2, '周三': 2, '星期三': 2,
        '四': 3, '4': 3, '周四': 3, '星期四': 3,
        '五': 4, '5': 4, '周五': 4, '星期五': 4,
        '六': 5, '6': 5, '周六': 5, '星期六': 5,
        '日': 6, '7': 6, '天': 6, '周日': 6, '星期日': 6, '星期天': 6,
    }
    
    # 时间段默认时间
    TIME_OF_DAY = {
        '早': 8, '早上': 8, '早晨': 8, '上午': 9,
        '中': 12, '中午': 12, '正午': 12, '午间': 12,
        '下': 15, '下午': 15,
        '傍': 18, '傍晚': 18, '黄昏': 18,
        '晚': 20, '晚上': 20, '夜晚': 21, '夜里': 21,
        '凌晨': 5, '深夜': 23, '半夜': 0,
    }
    
    def __init__(self, now: datetime = None):
        self.now = now or datetime.now()
    
    def parse(self, text: str) -> Dict[str, Any]:
        """解析自然语言，返回提醒数据结构"""
        text = text.strip()
        if not text:
            return {"error": "请输入消息内容"}
        
        result = {
            "title": text[:50],
            "content": text,
            "category": self._detect_category(text),
            "reminder_type": "once",
            "remind_at": None,
            "confidence": 0.8,
            "suggestions": []
        }
        
        # 解析时间
        parsed_time = self._parse_time(text)
        if parsed_time:
            result["remind_at"] = parsed_time.isoformat()
            result["confidence"] = 0.95
        else:
            result["suggestions"].append("未能识别具体时间，请手动设置")
        
        # 提取更精炼的标题
        result["title"] = self._extract_title(text, parsed_time)
        
        return result
    
    def _detect_category(self, text: str) -> str:
        """检测事件分类"""
        text_lower = text.lower()
        
        homework_keywords = ['作业', '交', '报告', '论文', '考试', '测验', 'quiz', 'assignment', 'homework', ' deadline']
        for kw in homework_keywords:
            if kw in text_lower:
                return "homework"
        
        group_keywords = ['会', '会议', '开会', '活动', '聚餐', '团建', '聚会', 'party', 'meeting', 'event']
        for kw in group_keywords:
            if kw in text_lower:
                return "group"
        
        return "task"
    
    def _extract_title(self, text: str, parsed_time: datetime = None) -> str:
        """从消息中提取精炼标题"""
        # 移除常见前缀
        prefixes = ['大家', '各位', '同学们', '同学们请注意', '通知', '温馨提示', '提醒']
        title = text
        for p in prefixes:
            if title.startswith(p):
                title = title[len(p):].strip()
        
        # 移除时间相关描述，保留核心事件
        # 简单处理：取前30个字符
        title = title[:40].strip()
        if len(title) < 5:
            title = text[:40].strip()
        
        return title
    
    def _parse_time(self, text: str) -> Optional[datetime]:
        """解析文本中的时间信息"""
        target_date = None
        target_time = None
        
        # ========== 日期解析 ==========
        
        # 今天
        if re.search(r'今天|今日|今儿', text):
            target_date = self.now.date()
        
        # 明天
        elif re.search(r'明天|明日|明儿|明早|明晚', text):
            target_date = (self.now + timedelta(days=1)).date()
        
        # 后天
        elif re.search(r'后天|后日', text):
            target_date = (self.now + timedelta(days=2)).date()
        
        # 大后天
        elif re.search(r'大后天', text):
            target_date = (self.now + timedelta(days=3)).date()
        
        # 下周X
        match = re.search(r'下[个]?周([一二三四五六日天1234567])', text)
        if match and not target_date:
            weekday_str = match.group(1)
            target_weekday = self.WEEKDAY_MAP.get(weekday_str)
            if target_weekday is not None:
                days_ahead = target_weekday - self.now.weekday()
                if days_ahead <= 0:
                    days_ahead += 7
                target_date = (self.now + timedelta(days=days_ahead)).date()
        
        # 这周X / 本周X
        match = re.search(r'[这本]周([一二三四五六日天1234567])', text)
        if match and not target_date:
            weekday_str = match.group(1)
            target_weekday = self.WEEKDAY_MAP.get(weekday_str)
            if target_weekday is not None:
                days_ahead = target_weekday - self.now.weekday()
                if days_ahead < 0:
                    days_ahead += 7
                if days_ahead == 0:
                    # 如果已经过了默认时间，推到下周
                    pass
                target_date = (self.now + timedelta(days=days_ahead)).date()
        
        # X月X号/X月X日
        match = re.search(r'(\d{1,2})[月/](\d{1,2})[号日]?', text)
        if match and not target_date:
            month, day = int(match.group(1)), int(match.group(2))
            year = self.now.year
            try:
                target_date = datetime(year, month, day).date()
                if target_date < self.now.date():
                    target_date = datetime(year + 1, month, day).date()
            except ValueError:
                pass
        
        # X号/X日（本月或下月）
        match = re.search(r'(\d{1,2})[号日]', text)
        if match and not target_date:
            day = int(match.group(1))
            try:
                target_date = datetime(self.now.year, self.now.month, day).date()
                if target_date < self.now.date():
                    # 下个月
                    next_month = self.now.month + 1
                    next_year = self.now.year
                    if next_month > 12:
                        next_month = 1
                        next_year += 1
                    target_date = datetime(next_year, next_month, day).date()
            except ValueError:
                pass
        
        # 几天后
        match = re.search(r'(\d+)[\s]*天[以之]?后', text)
        if match and not target_date:
            days = int(match.group(1))
            target_date = (self.now + timedelta(days=days)).date()
        
        # ========== 时间解析 ==========
        
        # 具体时间 HH:MM
        match = re.search(r'(\d{1,2}):(\d{2})', text)
        if match:
            hour, minute = int(match.group(1)), int(match.group(2))
            target_time = (hour, minute)
        
        # X点Y分 / X点
        match = re.search(r'(\d{1,2})[点:](\d{1,2})?分?', text)
        if match and not target_time:
            hour = int(match.group(1))
            minute = int(match.group(2)) if match.group(2) else 0
            target_time = (hour, minute)
        
        # 时间段描述（如果没有具体时间）
        if not target_time:
            for period, default_hour in self.TIME_OF_DAY.items():
                if period in text:
                    target_time = (default_hour, 0)
                    break
        
        # AM/PM 修正
        if target_time:
            hour, minute = target_time
            # 如果文本有"下午/晚上/傍晚"且时间小于12，加12小时
            if hour < 12 and re.search(r'下午|晚上|傍晚|黄昏|晚', text):
                hour += 12
            # 如果文本有"凌晨"且时间大于12，减12
            if hour > 12 and re.search(r'凌晨|半夜', text):
                hour -= 12
            target_time = (hour, minute)
        
        # 组装最终时间
        if target_date or target_time:
            if not target_date:
                target_date = self.now.date()
            if not target_time:
                # 默认早上9点
                target_time = (9, 0)
            
            result = datetime.combine(target_date, datetime.min.time().replace(hour=target_time[0], minute=target_time[1]))
            
            # 如果解析出的时间已经过了，且没有明确日期，推到明天
            if result < self.now and not re.search(r'(\d{1,2})[月/](\d{1,2})', text):
                result = result + timedelta(days=1)
            
            return result
        
        return None


def parse_reminder(text: str) -> Dict[str, Any]:
    """便捷函数：解析提醒文本"""
    parser = ReminderParser()
    return parser.parse(text)


# 测试
if __name__ == "__main__":
    test_cases = [
        "明天下午3点交作业",
        "周五上午10点开会",
        "下周一交报告",
        "明天记得带身份证",
        "后天晚上聚餐",
        "12月25号圣诞节活动",
        "3天后交论文",
        "今天下午5点下班",
    ]
    
    for tc in test_cases:
        result = parse_reminder(tc)
        print(f"\n原文: {tc}")
        print(f"  标题: {result['title']}")
        print(f"  分类: {result['category']}")
        print(f"  时间: {result['remind_at']}")
        print(f"  置信度: {result['confidence']}")
