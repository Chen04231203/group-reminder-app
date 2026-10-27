// ===== 配置 =====
const API_BASE = window.location.origin;
let currentView = 'dashboard';
let reminders = [];
let ws = null;
let notificationEnabled = false;

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  initPWA();
  initWebSocket();
  initUI();
  loadSettings();
  loadStats();
  loadReminders();
  requestNotificationPermission();
});

// ===== PWA =====
function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/sw.js')
      .then(reg => console.log('SW registered'))
      .catch(err => console.log('SW failed:', err));
  }
}

// ===== WebSocket =====
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  
  ws.onopen = () => {
    console.log('WebSocket connected');
    // 心跳保活
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 30000);
  };
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'reminder_triggered') {
      handleReminderTriggered(data.data);
    }
  };
  
  ws.onclose = () => {
    console.log('WebSocket closed, reconnecting...');
    setTimeout(initWebSocket, 3000);
  };
}

// ===== UI 初始化 =====
function initUI() {
  // 侧边栏
  document.getElementById('menuToggle').addEventListener('click', toggleSidebar);
  document.getElementById('sidebarClose').addEventListener('click', toggleSidebar);
  document.getElementById('overlay').addEventListener('click', toggleSidebar);
  
  // 导航
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const view = item.dataset.view;
      switchView(view);
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      if (window.innerWidth <= 768) toggleSidebar();
    });
  });
  
  // 新建提醒
  document.getElementById('btnAddReminder').addEventListener('click', () => openModal());
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('btnCancel').addEventListener('click', closeModal);
  document.getElementById('reminderForm').addEventListener('submit', handleFormSubmit);
  
  // 分类选择
  document.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  
  // 提醒类型切换
  document.getElementById('formType').addEventListener('change', (e) => {
    const isCustom = e.target.value === 'custom';
    document.getElementById('datetimeGroup').style.display = isCustom ? 'none' : 'block';
    document.getElementById('customScheduleGroup').style.display = isCustom ? 'block' : 'none';
    if (!isCustom) {
      document.getElementById('formCron').value = '';
    }
  });
  
  // 自定义时间选择器
  initCustomSchedule();
  
  // AI 智能识别
  document.getElementById('btnAIParse').addEventListener('click', openAiModal);
  document.getElementById('aiModalClose').addEventListener('click', closeAiModal);
  document.getElementById('btnAiCancel').addEventListener('click', closeAiModal);
  document.getElementById('btnAiParse').addEventListener('click', handleAiParse);
  document.getElementById('btnAiConfirm').addEventListener('click', handleAiConfirm);
  
  // 搜索
  document.getElementById('btnSearch').addEventListener('click', () => {
    const bar = document.getElementById('searchBar');
    bar.style.display = bar.style.display === 'none' ? 'flex' : 'none';
    if (bar.style.display !== 'none') document.getElementById('searchInput').focus();
  });
  document.getElementById('searchClose').addEventListener('click', () => {
    document.getElementById('searchBar').style.display = 'none';
    document.getElementById('searchInput').value = '';
    renderReminders();
  });
  document.getElementById('searchInput').addEventListener('input', (e) => {
    renderReminders(e.target.value);
  });
  
  // 刷新
  document.getElementById('btnRefresh').addEventListener('click', () => {
    loadStats();
    loadReminders();
    showToast('已刷新');
  });
  
  // 声音开关
  document.getElementById('soundToggle').addEventListener('change', (e) => {
    updateGlobalSound(e.target.checked);
  });
  
  // 通知开关
  document.getElementById('notificationToggle').addEventListener('change', (e) => {
    if (e.target.checked) {
      requestNotificationPermission();
    }
  });
  
  // 通知弹窗
  document.getElementById('btnDismiss').addEventListener('click', () => {
    document.getElementById('notificationModal').classList.remove('show');
  });
  document.getElementById('btnCopyContent').addEventListener('click', () => {
    const content = document.getElementById('notifBody').textContent;
    copyToClipboard(content);
    document.getElementById('notificationModal').classList.remove('show');
  });
  
  // ESC 关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      document.getElementById('notificationModal').classList.remove('show');
    }
  });
}

// ===== 视图切换 =====
function switchView(view) {
  currentView = view;
  const titles = {
    dashboard: '概览',
    reminders: '全部提醒',
    groups: '群通知',
    tasks: '任务提醒',
    homework: '作业提醒'
  };
  document.getElementById('pageTitle').textContent = titles[view] || '提醒助手';
  
  // 控制统计卡片显示
  const statsGrid = document.getElementById('statsGrid');
  statsGrid.style.display = view === 'dashboard' ? 'grid' : 'none';
  
  renderReminders();
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('show');
}

// ===== 数据加载 =====
async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    const data = await res.json();
    document.getElementById('statTotal').textContent = data.total;
    document.getElementById('statActive').textContent = data.active;
    document.getElementById('statGroup').textContent = data.group;
    document.getElementById('statTask').textContent = data.task;
    document.getElementById('statHomework').textContent = data.homework;
    document.getElementById('statToday').textContent = data.today;
  } catch (e) {
    console.error('加载统计失败:', e);
  }
}

async function loadReminders() {
  try {
    const url = currentView === 'dashboard' || currentView === 'reminders'
      ? `${API_BASE}/api/reminders`
      : `${API_BASE}/api/reminders?category=${currentView}`;
    const res = await fetch(url);
    reminders = await res.json();
    renderReminders();
  } catch (e) {
    console.error('加载提醒失败:', e);
    showToast('加载失败，请检查后端是否运行');
  }
}

// ===== 渲染提醒列表 =====
function renderReminders(search = '') {
  const list = document.getElementById('reminderList');
  const empty = document.getElementById('emptyState');
  
  let filtered = reminders;
  
  // 按视图筛选
  if (currentView !== 'dashboard' && currentView !== 'reminders') {
    filtered = filtered.filter(r => r.category === currentView);
  }
  
  // 搜索筛选
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(r => 
      r.title.toLowerCase().includes(s) || 
      (r.content && r.content.toLowerCase().includes(s))
    );
  }
  
  // 排序：活跃的在前，然后按创建时间倒序
  filtered.sort((a, b) => {
    if (a.is_active !== b.is_active) return b.is_active ? 1 : -1;
    return new Date(b.created_at) - new Date(a.created_at);
  });
  
  if (filtered.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  
  empty.style.display = 'none';
  
  const categoryLabels = { group: '群通知', task: '任务', homework: '作业' };
  const typeLabels = { once: '一次性', daily: '每天', weekly: '每周', custom: '自定义' };
  const categoryColors = { group: 'tag-group', task: 'tag-task', homework: 'tag-homework' };
  
  list.innerHTML = filtered.map(r => {
    const remindTime = r.remind_at 
      ? formatDateTime(new Date(r.remind_at)) 
      : (r.cron_expression || '未设置时间');
    
    return `
      <div class="reminder-card ${r.is_active ? '' : 'inactive'}">
        <div class="reminder-status ${r.is_active ? 'active' : 'inactive'}"></div>
        <div class="reminder-content">
          <div class="reminder-title">
            ${escapeHtml(r.title)}
            <span class="reminder-tag ${categoryColors[r.category] || 'tag-group'}">${categoryLabels[r.category] || r.category}</span>
            <span class="reminder-tag tag-type">${typeLabels[r.reminder_type] || r.reminder_type}</span>
          </div>
          ${r.content ? `<div class="reminder-desc">${escapeHtml(r.content)}</div>` : ''}
          <div class="reminder-meta">
            <span>&#128336; ${remindTime}</span>
            ${r.sound_enabled ? '<span>&#128266; 声音</span>' : ''}
            ${r.push_enabled ? '<span>&#128276; 推送</span>' : ''}
            ${r.trigger_count > 0 ? `<span>&#9851; 已触发 ${r.trigger_count} 次</span>` : ''}
          </div>
        </div>
        <div class="reminder-actions">
          <button class="btn-action copy" title="复制内容" onclick="copyReminderContent(${r.id})">&#128203;</button>
          <button class="btn-action trigger" title="立即触发" onclick="triggerReminder(${r.id})">&#9654;</button>
          <button class="btn-action edit" title="编辑" onclick="editReminder(${r.id})">&#9998;</button>
          <button class="btn-action delete" title="删除" onclick="deleteReminder(${r.id})">&#128465;</button>
        </div>
      </div>
    `;
  }).join('');
}

// ===== 弹窗操作 =====
function openModal(reminder = null) {
  const modal = document.getElementById('reminderModal');
  const title = document.getElementById('modalTitle');
  const form = document.getElementById('reminderForm');
  
  form.reset();
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.cat-btn[data-value="group"]').classList.add('active');
  document.getElementById('datetimeGroup').style.display = 'block';
  document.getElementById('customScheduleGroup').style.display = 'none';
  
  // 重置自定义时间选择器
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.weekday-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('formCron').value = '';
  document.getElementById('formCronManual').value = '';
  document.getElementById('advancedCronInput').style.display = 'none';
  
  if (reminder) {
    title.textContent = '编辑提醒';
    document.getElementById('reminderId').value = reminder.id;
    document.getElementById('formTitle').value = reminder.title;
    document.getElementById('formContent').value = reminder.content || '';
    document.getElementById('formType').value = reminder.reminder_type;
    document.getElementById('formSound').checked = reminder.sound_enabled;
    document.getElementById('formPush').checked = reminder.push_enabled;
    document.getElementById('formWebhook').value = reminder.webhook_url || '';
    
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.cat-btn[data-value="${reminder.category}"]`)?.classList.add('active');
    
    if (reminder.remind_at) {
      const dt = new Date(reminder.remind_at);
      dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
      document.getElementById('formDatetime').value = dt.toISOString().slice(0, 16);
    }
    
    if (reminder.cron_expression) {
      document.getElementById('formCron').value = reminder.cron_expression;
    }
    
    if (reminder.reminder_type === 'custom') {
      document.getElementById('datetimeGroup').style.display = 'none';
      document.getElementById('customScheduleGroup').style.display = 'block';
    }
  } else {
    title.textContent = '新建提醒';
    document.getElementById('reminderId').value = '';
    // 默认设置明天同一时间
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setMinutes(tomorrow.getMinutes() - tomorrow.getTimezoneOffset());
    document.getElementById('formDatetime').value = tomorrow.toISOString().slice(0, 16);
  }
  
  modal.classList.add('show');
}

function closeModal() {
  document.getElementById('reminderModal').classList.remove('show');
}

// ===== 表单提交 =====
async function handleFormSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById('reminderId').value;
  const categoryBtn = document.querySelector('.cat-btn.active');
  
  const data = {
    title: document.getElementById('formTitle').value.trim(),
    content: document.getElementById('formContent').value.trim(),
    category: categoryBtn ? categoryBtn.dataset.value : 'group',
    reminder_type: document.getElementById('formType').value,
    sound_enabled: document.getElementById('formSound').checked,
    push_enabled: document.getElementById('formPush').checked,
    webhook_url: document.getElementById('formWebhook').value.trim() || null
  };
  
  if (data.reminder_type === 'custom') {
    data.cron_expression = document.getElementById('formCron').value.trim();
  } else {
    const dt = document.getElementById('formDatetime').value;
    if (dt) data.remind_at = new Date(dt).toISOString();
  }
  
  try {
    const url = id ? `${API_BASE}/api/reminders/${id}` : `${API_BASE}/api/reminders`;
    const method = id ? 'PUT' : 'POST';
    
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    if (res.ok) {
      closeModal();
      showToast(id ? '更新成功' : '创建成功');
      loadStats();
      loadReminders();
    } else {
      const err = await res.json();
      showToast(err.detail || '操作失败');
    }
  } catch (e) {
    showToast('网络错误');
  }
}

// ===== 提醒操作 =====
async function editReminder(id) {
  const r = reminders.find(x => x.id === id);
  if (r) openModal(r);
}

async function deleteReminder(id) {
  if (!confirm('确定要删除这个提醒吗？')) return;
  
  try {
    const res = await fetch(`${API_BASE}/api/reminders/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('删除成功');
      loadStats();
      loadReminders();
    }
  } catch (e) {
    showToast('删除失败');
  }
}

async function triggerReminder(id) {
  try {
    const res = await fetch(`${API_BASE}/api/reminders/${id}/trigger`, { method: 'POST' });
    if (res.ok) {
      showToast('已触发提醒');
      loadStats();
    }
  } catch (e) {
    showToast('触发失败');
  }
}

function copyReminderContent(id) {
  const r = reminders.find(x => x.id === id);
  if (!r) return;
  const text = `【${r.title}】\n${r.content || ''}`;
  copyToClipboard(text);
}

// ===== 通知处理 =====
function handleReminderTriggered(data) {
  // 播放声音
  if (data.sound_enabled) {
    playNotificationSound();
  }
  
  // 浏览器推送
  if (data.push_enabled && notificationEnabled) {
    showBrowserNotification(data.title, data.content);
  }
  
  // 显示弹窗
  document.getElementById('notifTitle').textContent = data.title;
  document.getElementById('notifBody').textContent = data.content || '您有一个新的提醒';
  document.getElementById('notificationModal').classList.add('show');
  
  showToast(`提醒：${data.title}`);
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  
  const permission = await Notification.requestPermission();
  notificationEnabled = permission === 'granted';
  document.getElementById('notificationToggle').checked = notificationEnabled;
  
  if (notificationEnabled) {
    showToast('推送通知已开启');
  }
}

function showBrowserNotification(title, body) {
  if (!notificationEnabled) return;
  
  new Notification(title, {
    body: body || '',
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    requireInteraction: true
  });
}

function playNotificationSound() {
  // 使用 Web Audio API 生成提示音
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {
    console.log('播放声音失败:', e);
  }
}

// ===== 工具函数 =====
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('已复制到剪贴板，去微信群粘贴吧！');
  }).catch(() => {
    // 降级方案
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('已复制到剪贴板，去微信群粘贴吧！');
  });
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function formatDateTime(date) {
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const isTomorrow = new Date(now.getTime() + 86400000).toDateString() === date.toDateString();
  
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  
  if (isToday) return `今天 ${time}`;
  if (isTomorrow) return `明天 ${time}`;
  
  const dateStr = date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  return `${dateStr} ${time}`;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== AI 智能识别 =====
let aiParsedResult = null;

function openAiModal() {
  document.getElementById('aiParseModal').classList.add('show');
  document.getElementById('aiInput').value = '';
  document.getElementById('aiInput').focus();
  document.getElementById('aiResult').style.display = 'none';
  document.getElementById('btnAiParse').style.display = 'inline-flex';
  document.getElementById('btnAiConfirm').style.display = 'none';
  aiParsedResult = null;
}

function closeAiModal() {
  document.getElementById('aiParseModal').classList.remove('show');
}

async function handleAiParse() {
  const text = document.getElementById('aiInput').value.trim();
  if (!text) {
    showToast('请输入消息内容');
    return;
  }
  
  document.getElementById('btnAiParse').textContent = '识别中...';
  document.getElementById('btnAiParse').disabled = true;
  
  try {
    const res = await fetch(`${API_BASE}/api/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    
    if (res.ok) {
      const data = await res.json();
      aiParsedResult = data;
      
      // 显示识别结果
      document.getElementById('aiResultTitle').textContent = data.title || '未识别';
      
      const catLabels = { group: '群通知', task: '任务', homework: '作业' };
      document.getElementById('aiResultCategory').textContent = catLabels[data.category] || data.category || '未识别';
      
      if (data.remind_at) {
        const dt = new Date(data.remind_at);
        document.getElementById('aiResultTime').textContent = dt.toLocaleString('zh-CN');
      } else {
        document.getElementById('aiResultTime').textContent = '未识别，请手动设置';
      }
      
      document.getElementById('aiResult').style.display = 'block';
      document.getElementById('btnAiParse').style.display = 'none';
      document.getElementById('btnAiConfirm').style.display = 'inline-flex';
      
      if (data.suggestions && data.suggestions.length > 0) {
        showToast(data.suggestions[0]);
      }
    } else {
      showToast('识别失败，请检查后端服务');
    }
  } catch (e) {
    showToast('网络错误');
  } finally {
    document.getElementById('btnAiParse').textContent = '\u{1F50D} 识别';
    document.getElementById('btnAiParse').disabled = false;
  }
}

async function handleAiConfirm() {
  if (!aiParsedResult) return;
  
  closeAiModal();
  
  // 打开新建弹窗并自动填充
  openModal();
  
  // 填充解析结果
  document.getElementById('formTitle').value = aiParsedResult.title || '';
  document.getElementById('formContent').value = aiParsedResult.content || '';
  
  // 设置分类
  if (aiParsedResult.category) {
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.cat-btn[data-value="${aiParsedResult.category}"]`)?.classList.add('active');
  }
  
  // 设置时间
  if (aiParsedResult.remind_at) {
    const dt = new Date(aiParsedResult.remind_at);
    dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
    document.getElementById('formDatetime').value = dt.toISOString().slice(0, 16);
  }
  
  showToast('已自动填充，请确认后保存');
}

// ===== 全局设置 =====
async function loadSettings() {
  try {
    const res = await fetch(`${API_BASE}/api/settings`);
    if (res.ok) {
      const settings = await res.json();
      // 声音开关
      const soundEnabled = settings.global_sound !== false;
      document.getElementById('soundToggle').checked = soundEnabled;
    }
  } catch (e) {
    console.log('加载设置失败:', e);
  }
}

async function updateGlobalSound(enabled) {
  try {
    const res = await fetch(`${API_BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ global_sound: enabled })
    });
    if (res.ok) {
      showToast(enabled ? '声音提醒已开启' : '声音提醒已关闭');
    }
  } catch (e) {
    showToast('设置保存失败');
    document.getElementById('soundToggle').checked = !enabled;
  }
}

// ===== 自定义时间选择器 =====
function initCustomSchedule() {
  let selectedWeekdays = [];
  let currentCron = '';
  
  // 预设模板
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.weekday-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedWeekdays = [];
      currentCron = btn.dataset.cron;
      document.getElementById('formCron').value = currentCron;
    });
  });
  
  // 星期选择
  document.querySelectorAll('.weekday-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.toggle('active');
      const day = btn.dataset.day;
      if (btn.classList.contains('active')) {
        if (!selectedWeekdays.includes(day)) selectedWeekdays.push(day);
      } else {
        selectedWeekdays = selectedWeekdays.filter(d => d !== day);
      }
      updateWeekdayCron();
    });
  });
  
  function updateWeekdayCron() {
    if (selectedWeekdays.length === 0) {
      document.getElementById('formCron').value = '';
      return;
    }
    const time = getCustomTime();
    const days = selectedWeekdays.sort((a, b) => parseInt(a) - parseInt(b)).join(',');
    currentCron = `${time.minute} ${time.hour} * * ${days}`;
    document.getElementById('formCron').value = currentCron;
  }
  
  // 间隔应用
  document.getElementById('btnApplyInterval').addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.weekday-btn').forEach(b => b.classList.remove('active'));
    selectedWeekdays = [];
    
    const num = parseInt(document.getElementById('intervalNum').value) || 1;
    const unit = document.getElementById('intervalUnit').value;
    const time = getCustomTime();
    
    if (unit === 'hour') {
      currentCron = `0 */${num} * * *`;
    } else if (unit === 'day') {
      currentCron = `${time.minute} ${time.hour} */${num} * *`;
    } else if (unit === 'week') {
      currentCron = `${time.minute} ${time.hour} * * ${time.weekday}`;
    }
    document.getElementById('formCron').value = currentCron;
    showToast(`已设置：每${num}${unit === 'hour' ? '小时' : unit === 'day' ? '天' : '周'}`);
  });
  
  // 高级模式切换
  document.getElementById('btnAdvancedCron').addEventListener('click', () => {
    const el = document.getElementById('advancedCronInput');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  });
  
  document.getElementById('formCronManual').addEventListener('input', (e) => {
    document.getElementById('formCron').value = e.target.value;
  });
  
  function getCustomTime() {
    const dt = document.getElementById('formDatetime').value;
    if (dt) {
      const d = new Date(dt);
      return {
        minute: d.getMinutes(),
        hour: d.getHours(),
        weekday: d.getDay()
      };
    }
    return { minute: 0, hour: 9, weekday: 1 };
  }
}
