"""
自然语言提醒解析器
把微信消息/自然语言解析成结构化的提醒数据
"""
import re
from datetime import datetime, timedelta
from typing import Optional, Dict, Any


# 中文数字映射
CN_NUM = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
}


def cn2num(s: str) -> Optional[int]:
    """中文数字转阿拉伯数字，支持 0-99
    例：十 → 10, 十三 → 13, 三十 → 30, 三十五 → 35, 两 → 2
    """
    if not s:
        return None
    # 纯阿拉伯数字直接返回
    if s.isdigit():
        return int(s)

    s = s.replace('零', '0').replace('〇', '0')

    if '十' not in s:
        # 单字数字，如 "三"
        if len(s) == 1 and s in CN_NUM:
            return CN_NUM[s]
        return None

    # 含"十"的情况
    parts = s.split('十')
    if len(parts) == 2:
        left, right = parts
        # 十 → 10
        if left == '' and right == '':
            return 10
        # 十三 → 13
        if left == '':
            r = CN_NUM.get(right)
            return 10 + r if r is not None else None
        # 三十 → 30
        if right == '':
            l = CN_NUM.get(left)
            return l * 10 if l is not None else None
        # 三十五 → 35
        l = CN_NUM.get(left)
        r = CN_NUM.get(right)
        if l is not None and r is not None:
            return l * 10 + r
    return None


def normalize_chinese_time(text: str) -> str:
    """把文本中的中文数字时间规范化为阿拉伯数字
    例："十点三十五" → "10点35"
        "三点半" → "3点30"
        "十点半" → "10点30"
        "二十分钟后" → "20分钟后"
    """
    # 中文数字字符集
    cn = '零〇一二两三四五六七八九十'

    # 1) X点半 → X点30
    text = re.sub(
        rf'([{cn}]+)点[半]',
        lambda m: f"{cn2num(m.group(1)) or 0}点30",
        text
    )

    # 2) X点Y分 / X点Y
    def repl_point(m):
        h = cn2num(m.group(1))
        mi = cn2num(m.group(2)) if m.group(2) else None
        if h is None:
            return m.group(0)
        if mi is None:
            return f"{h}点"
        return f"{h}点{mi}"
    text = re.sub(rf'([{cn}]+)点([{cn}]+)?分?', repl_point, text)

    # 3) X点（无分钟）
    text = re.sub(
        rf'([{cn}]+)点',
        lambda m: f"{cn2num(m.group(1)) or 0}点",
        text
    )

    # 4) X分钟 / X小时
    text = re.sub(
        rf'([{cn}]+)(分钟|小时|天|周|个?星期|号|日)',
        lambda m: f"{cn2num(m.group(1)) or 0}{m.group(2)}",
        text
    )

    return text


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
            "cron_expression": None,
            "remind_at": None,
            "confidence": 0.8,
            "suggestions": []
        }
        
        # 中文数字规范化（"十点三十五" → "10点35"）
        normalized = normalize_chinese_time(text)

        # 解析时间
        parsed_time = self._parse_time(normalized)
        if parsed_time:
            result["remind_at"] = parsed_time.isoformat()
            result["confidence"] = 0.95
        else:
            result["suggestions"].append("未能识别具体时间，请手动设置")

        # 识别重复规则（每周一三五 / 每天 / 每月1号 / 每2小时 ...）
        repeat = self._detect_repeat(text, parsed_time)
        if repeat:
            rtype, cron, nxt = repeat
            result["reminder_type"] = rtype
            result["cron_expression"] = cron
            if nxt:
                result["remind_at"] = nxt.isoformat()
            result["confidence"] = 0.95
        
        # 提取更精炼的标题（用规范化后的文本，避免"十点三十五"残留）
        result["title"] = self._extract_title(normalized, parsed_time)
        
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
    
    # 标题清理用：需要从原文中剔除的时间/口头语片段
    _TITLE_NOISE = [
        r'大后天', r'今天|今日|今儿', r'明天|明日|明儿|明早|明晚', r'后天|后日',
        r'下[个]?周[一二三四五六日天1234567]', r'[这本]周[一二三四五六日天1234567]',
        r'每(?:周|星期|礼拜)[一二三四五六日天1234567、,和及]+',
        r'每\s*\d+\s*[个]?\s*(?:小时|天|分钟)',
        r'星期[一二三四五六日天]', r'礼拜[一二三四五六日天]',
        r'(?<![每下这本])周[一二三四五六日天1-7]',
        r'每(?:天|日|天早上|天晚上)', r'每(?:个)?月\d{1,2}[号日]',
        r'\d{1,2}[月/]\d{1,2}[号日]?', r'\d{1,2}[号日](?![常])',
        r'\d{1,2}\s*[:：]\s*\d{2}', r'\d{1,2}\s*[点时](?:半|\d{1,2})?分?(?:钟)?',
        r'\d+\s*分钟[之以]?后', r'半\s*[个]?\s*小时[之以]?后',
        r'\d+\s*[个]?\s*小时[之以]?后', r'\d+\s*秒[之以]?后', r'\d+\s*[天日][之以]?后',
        r'一会[儿]?后|马上|立刻|待会[儿]?',
        r'早上|早晨|清晨|上午|中午|正午|午间|下午|傍晚|黄昏|晚上|夜晚|夜里|凌晨|深夜|半夜',
        r'大家|各位|同学们|同学|请注意|注意|温馨提示|通知|提醒我|提醒一下|记得|别忘了|别忘记|要记得|准时|按时',
    ]

    def _extract_title(self, text: str, parsed_time: datetime = None) -> str:
        """从消息中提取精炼标题（去掉时间描述和口头语）"""
        title = text
        for pat in self._TITLE_NOISE:
            title = re.sub(pat, ' ', title)

        # 清理多余标点和空白
        title = re.sub(r'[，,、。；;：:\s]+', ' ', title).strip()
        title = title.strip('，,。.、；;：: ')

        # 去掉开头的连接词
        title = re.sub(r'^(要|去|来|的|了|把|给|在|和|跟)+', '', title).strip()
        # 去掉结尾的助词
        title = re.sub(r'(了|吧|啊|呀|哦|呢|吗)$', '', title).strip()

        # 太短说明清理过度，退回"只去口头语"的轻度清理
        if len(title) < 2:
            t2 = re.sub(
                r'提醒我|提醒一下|记得|别忘了|别忘记|要记得|大家|各位|同学们|请注意|注意',
                ' ', text)
            t2 = re.sub(r'[，,、。；;：:\s]+', ' ', t2).strip()
            title = t2 if len(t2) >= 2 else '提醒'

        return title[:40].strip()
    
    def _parse_time(self, text: str) -> Optional[datetime]:
        """解析文本中的时间信息"""
        target_date = None
        target_time = None

        # ========== 相对时间（优先级最高，直接返回） ==========

        # X分钟后
        m = re.search(r'(\d+)\s*分钟[之以]?后', text)
        if m:
            return self.now + timedelta(minutes=int(m.group(1)))

        # 半小时后
        if re.search(r'半\s*[个]?\s*小时[之以]?后', text):
            return self.now + timedelta(minutes=30)

        # X小时后
        m = re.search(r'(\d+)\s*[个]?\s*小时[之以]?后', text)
        if m:
            return self.now + timedelta(hours=int(m.group(1)))

        # X秒后
        m = re.search(r'(\d+)\s*秒[之以]?后', text)
        if m:
            return self.now + timedelta(seconds=int(m.group(1)))

        # 一会儿后 / 马上（默认15分钟后）
        if re.search(r'一会[儿]?后|马上|立刻|待会[儿]?', text):
            return self.now + timedelta(minutes=15)

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
        
        # 每周X（取未来最近的那个星期几）
        match = re.search(r'每(?:周|星期|礼拜)([一二三四五六日天1-7])', text)
        if match and not target_date:
            target_weekday = self.WEEKDAY_MAP.get(match.group(1))
            if target_weekday is not None:
                for i in range(0, 8):
                    d = (self.now + timedelta(days=i)).date()
                    if d.weekday() == target_weekday:
                        target_date = d
                        break

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
            # 只认两字以上的时间段词，避免"下周一"的"下"被当成"下午"
            for period, default_hour in sorted(
                    self.TIME_OF_DAY.items(), key=lambda kv: -len(kv[0])):
                if len(period) >= 2 and period in text:
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
            # 没说上下午的 1~6 点，按下午算（"三点半交作业"→15:30）
            # 但明确是凌晨/早上/起床的除外
            if 1 <= hour <= 6 and not re.search(
                    r'凌晨|半夜|深夜|早上|早晨|清晨|上午|起床|晨', text):
                hour += 12
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


    def _next_on_weekdays(self, days, hour: int, minute: int) -> Optional[datetime]:
        """找出未来最近一个落在指定星期集合里的时间点"""
        for i in range(0, 8):
            d = (self.now + timedelta(days=i)).date()
            if d.weekday() in days:
                cand = datetime(d.year, d.month, d.day, hour, minute)
                if cand > self.now:
                    return cand
        return None

    def _next_on_monthday(self, day: int, hour: int, minute: int) -> Optional[datetime]:
        """找出未来最近一个指定日号的时间点"""
        for offset in (0, 1):
            y, mo = self.now.year, self.now.month + offset
            if mo > 12:
                mo -= 12
                y += 1
            try:
                cand = datetime(y, mo, day, hour, minute)
            except ValueError:
                continue
            if cand > self.now:
                return cand
        return None

    def _detect_repeat(self, text: str, parsed_time: Optional[datetime]):
        """识别重复规则，返回 (reminder_type, cron_expression, next_occurrence)"""

        # 每N小时（不依赖具体时间点）
        m = re.search(r'每\s*(\d+)\s*[个]?\s*小时', text)
        if m:
            n = int(m.group(1))
            if 1 <= n <= 23:
                base = self.now.replace(minute=0, second=0, microsecond=0)
                nxt = None
                for k in range(1, n + 2):
                    cand = base + timedelta(hours=k)
                    if cand.hour % n == 0:
                        nxt = cand
                        break
                return 'custom', f"0 */{n} * * *", nxt or (self.now + timedelta(hours=n))

        # 每N天（不依赖具体时间点）
        m = re.search(r'每\s*(\d+)\s*天', text)
        if m:
            n = int(m.group(1))
            if 1 <= n <= 30:
                nxt = (self.now + timedelta(days=1)).replace(
                    hour=9, minute=0, second=0, microsecond=0)
                return 'custom', f"0 9 */{n} * *", nxt

        if not parsed_time:
            return None

        hour, minute = parsed_time.hour, parsed_time.minute

        # 每周一三五 / 每星期一、三、五 / 每礼拜二
        m = re.search(r'每(?:周|星期|礼拜)([一二三四五六日天1-7、,，和及]+)', text)
        if m:
            days = []
            for ch in m.group(1):
                if ch in ('、', ',', '，', '和', '及'):
                    continue
                wd = self.WEEKDAY_MAP.get(ch)
                if wd is not None and wd not in days:
                    days.append(wd)
            if days:
                days.sort()
                cron = f"{minute} {hour} * * {','.join(str(d) for d in days)}"
                nxt = self._next_on_weekdays(days, hour, minute)
                rtype = 'weekly' if len(days) == 1 else 'custom'
                return rtype, cron, nxt or parsed_time

        # 每天 / 每日 / 天天
        if re.search(r'每(?:天|日)|天天', text):
            return 'daily', f"{minute} {hour} * * *", parsed_time

        # 每月X号
        m = re.search(r'每(?:个)?月(\d{1,2})[号日]', text)
        if m:
            day = int(m.group(1))
            if 1 <= day <= 31:
                nxt = self._next_on_monthday(day, hour, minute)
                return 'custom', f"{minute} {hour} {day} * *", nxt or parsed_time

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
