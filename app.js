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
  initPushUI();
  initChannels();
});

// ===== PWA =====
function initPWA() {
  if ('serviceWorker' in navigator) {
    // 必须从根路径注册，作用域才能覆盖整站
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => {
        console.log('SW registered, scope:', reg.scope);
        // 有新版本时自动接管，避免用户一直用旧缓存
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (nw) nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              nw.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
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
  
  // 快捷日期/时间按钮
  initQuickDatetime();
  
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
    // 默认 1 小时后（避免移动端显示空白）
    const soon = new Date();
    soon.setHours(soon.getHours() + 1);
    soon.setMinutes(0, 0, 0);
    soon.setMinutes(soon.getMinutes() - soon.getTimezoneOffset());
    document.getElementById('formDatetime').value = soon.toISOString().slice(0, 16);
  }
  
  // 清理快捷按钮状态
  document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
  updateDatetimeHint();
  
  modal.classList.add('show');
}

// 更新日期提示文字
function updateDatetimeHint() {
  const val = document.getElementById('formDatetime').value;
  const hint = document.getElementById('datetimeHint');
  if (!hint) return;
  if (!val) {
    hint.textContent = '当前选择：未设置';
    return;
  }
  const d = new Date(val);
  hint.textContent = `当前选择：${formatDateTime(d)}`;
}

// 快捷日期/时间按钮
function initQuickDatetime() {
  // 快捷日期
  document.querySelectorAll('.quick-btn[data-day]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.quick-btn[data-day]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const days = parseInt(btn.dataset.day);
      const input = document.getElementById('formDatetime');
      let base = input.value ? new Date(input.value) : new Date();
      if (!input.value) {
        base.setHours(new Date().getHours() + 1, 0, 0, 0);
      }
      const target = new Date();
      target.setDate(target.getDate() + days);
      target.setHours(base.getHours(), base.getMinutes(), 0, 0);
      target.setMinutes(target.getMinutes() - target.getTimezoneOffset());
      input.value = target.toISOString().slice(0, 16);
      updateDatetimeHint();
    });
  });
  
  // 快捷时间
  document.querySelectorAll('.quick-btn[data-time]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.quick-btn[data-time]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const input = document.getElementById('formDatetime');
      const [h, m] = btn.dataset.time.split(':').map(Number);
      let base = input.value ? new Date(input.value) : new Date();
      base.setHours(h, m, 0, 0);
      base.setMinutes(base.getMinutes() - base.getTimezoneOffset());
      input.value = base.toISOString().slice(0, 16);
      updateDatetimeHint();
    });
  });
  
  // 手动改时间也更新提示
  document.getElementById('formDatetime').addEventListener('change', updateDatetimeHint);
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
    updateDatetimeHint();
  }

  // 设置重复规则（AI 识别出"每周一三五""每天"时自动套用）
  if (aiParsedResult.reminder_type && aiParsedResult.reminder_type !== 'once') {
    const typeSel = document.getElementById('formType');
    typeSel.value = aiParsedResult.reminder_type;
    const isCustom = aiParsedResult.reminder_type === 'custom';
    document.getElementById('datetimeGroup').style.display = isCustom ? 'none' : 'block';
    document.getElementById('customScheduleGroup').style.display = isCustom ? 'block' : 'none';
    if (isCustom && aiParsedResult.cron_expression) {
      document.getElementById('formCron').value = aiParsedResult.cron_expression;
      document.getElementById('formCronManual').value = aiParsedResult.cron_expression;
      showToast(`已识别重复规则：${aiParsedResult.cron_expression}`);
    }
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

// ===== 系统推送（Web Push）：关掉网页也能收到 =====
let swRegistration = null;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function initPushUI() {
  const stateEl = document.getElementById('pushState');
  const hintEl = document.getElementById('pushHint');
  const btn = document.getElementById('btnEnablePush');
  const testBtn = document.getElementById('btnTestPush');
  if (!btn) return;

  if (!pushSupported()) {
    stateEl.textContent = '不支持';
    stateEl.className = 'push-state off';
    hintEl.textContent = isIOS() && !isStandalone()
      ? 'iPhone 需先「添加到主屏幕」，再从桌面图标打开才能开启推送'
      : '当前浏览器不支持系统推送，建议用 Chrome / Edge / Safari';
    btn.disabled = true;
    btn.textContent = '当前环境不支持';
    return;
  }

  // iOS 只有"添加到主屏幕"后的 PWA 模式才允许订阅
  if (isIOS() && !isStandalone()) {
    stateEl.textContent = '需加到主屏幕';
    stateEl.className = 'push-state off';
    hintEl.textContent = '点浏览器底部分享按钮 → 「添加到主屏幕」，再从桌面图标打开本页，才能开启推送';
    btn.disabled = true;
    btn.textContent = '请先添加到主屏幕';
    return;
  }

  btn.addEventListener('click', enablePush);
  testBtn.addEventListener('click', testPush);
  await refreshPushState();
}

async function refreshPushState() {
  const stateEl = document.getElementById('pushState');
  const hintEl = document.getElementById('pushHint');
  const btn = document.getElementById('btnEnablePush');
  const testBtn = document.getElementById('btnTestPush');
  if (!stateEl) return;

  try {
    swRegistration = await navigator.serviceWorker.ready;
    const sub = await swRegistration.pushManager.getSubscription();
    const perm = Notification.permission;

    if (sub && perm === 'granted') {
      stateEl.textContent = '已开启';
      stateEl.className = 'push-state on';
      hintEl.textContent = '关掉网页也能收到提醒，可以点下面发一条测试看看';
      btn.textContent = '重新订阅';
      testBtn.style.display = 'block';
      syncSubscription(sub); // 服务端重启后自动补登记
    } else if (perm === 'denied') {
      stateEl.textContent = '已被拒绝';
      stateEl.className = 'push-state off';
      hintEl.textContent = '通知权限被浏览器拒绝了，需到浏览器设置里手动允许本站通知';
      btn.textContent = '去开启（需手动改设置）';
      testBtn.style.display = 'none';
    } else {
      stateEl.textContent = '未开启';
      stateEl.className = 'push-state';
      hintEl.textContent = '开启后关掉网页也能收到提醒';
      btn.textContent = '开启系统推送';
      testBtn.style.display = 'none';
    }
  } catch (e) {
    console.log('读取推送状态失败', e);
  }
}

async function enablePush() {
  const btn = document.getElementById('btnEnablePush');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在开启...';

  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      showToast('没有获得通知权限，无法推送');
      await refreshPushState();
      return;
    }

    swRegistration = await navigator.serviceWorker.ready;
    const res = await fetch(`${API_BASE}/api/push/vapid-public-key`);
    const { publicKey } = await res.json();

    let sub = await swRegistration.pushManager.getSubscription();
    if (!sub) {
      sub = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }

    await syncSubscription(sub);
    showToast('系统推送已开启，关掉网页也能收到啦');
    await refreshPushState();
  } catch (e) {
    console.error(e);
    showToast('开启失败：' + (e.message || e));
    btn.textContent = old;
  } finally {
    btn.disabled = false;
  }
}

async function syncSubscription(sub) {
  const ua = navigator.userAgent;
  const device = /iPhone|iPad|iPod/.test(ua) ? 'iPhone/iPad'
    : /Android/.test(ua) ? 'Android 手机'
      : '电脑浏览器';
  try {
    const keys = (sub.toJSON && sub.toJSON().keys) || {};
    await fetch(`${API_BASE}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, keys, device })
    });
  } catch (e) {
    console.log('同步订阅失败', e);
  }
}

async function testPush() {
  const btn = document.getElementById('btnTestPush');
  btn.disabled = true;
  btn.textContent = '发送中...';
  try {
    const res = await fetch(`${API_BASE}/api/push/test`, { method: 'POST' });
    const data = await res.json();
    showToast(data.message || '已发送');
  } catch (e) {
    showToast('发送失败，请检查网络');
  } finally {
    btn.disabled = false;
    btn.textContent = '发一条测试推送';
  }
}

// ===== 微信推送（PushPlus）/ 企业微信群机器人 =====
let wecomConfigured = false;

async function initChannels() {
  const stateEl = document.getElementById('pushplusState');
  const input = document.getElementById('pushplusToken');
  const btn = document.getElementById('btnSavePushplus');
  const wecomBtn = document.getElementById('btnSaveWecom');
  if (!btn) return;

  btn.addEventListener('click', savePushplus);
  if (wecomBtn) wecomBtn.addEventListener('click', saveWecom);

  try {
    const res = await fetch(`${API_BASE}/api/channels`);
    const data = await res.json();

    if (data.pushplus_set) {
      stateEl.textContent = '已配置';
      stateEl.className = 'push-state on';
      input.placeholder = (data.pushplus_hint || '已配置') + '（留空则不修改）';
    }

    const wecomState = document.getElementById('wecomState');
    wecomConfigured = !!data.wecom_set;
    if (wecomConfigured) {
      wecomState.textContent = '已配置';
      wecomState.className = 'push-state on';
      document.getElementById('wecomWebhook').placeholder =
        (data.wecom_hint || '已配置') + '（留空则不修改）';
    }
  } catch (e) {
    console.log('读取推送渠道失败', e);
  }
}

async function savePushplus() {
  const input = document.getElementById('pushplusToken');
  const stateEl = document.getElementById('pushplusState');
  const btn = document.getElementById('btnSavePushplus');
  const token = input.value.trim();

  btn.disabled = true;
  btn.textContent = '保存中...';

  try {
    if (token) {
      const r = await fetch(`${API_BASE}/api/channels`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pushplus_token: token })
      });
      if (!r.ok) throw new Error('保存失败');
    }

    const t = await fetch(`${API_BASE}/api/channels/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'pushplus' })
    });
    const data = await t.json();

    if (data.ok) {
      showToast('已发一条测试消息到微信，去看看');
      stateEl.textContent = '已配置';
      stateEl.className = 'push-state on';
      input.value = '';
      input.placeholder = '已配置（留空则不修改）';
    } else {
      showToast(data.message || '测试失败');
    }
  } catch (e) {
    showToast('操作失败：' + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并测试';
  }
}

async function saveWecom() {
  const input = document.getElementById('wecomWebhook');
  const stateEl = document.getElementById('wecomState');
  const btn = document.getElementById('btnSaveWecom');
  const hook = input.value.trim();

  if (!hook && !wecomConfigured) {
    showToast('请先粘贴企业微信群机器人 Webhook 地址');
    return;
  }
  if (hook && !hook.includes('qyapi.weixin.qq.com')) {
    showToast('这不像企业微信机器人地址，检查一下有没有复制完整');
    return;
  }

  btn.disabled = true;
  btn.textContent = '保存中...';

  try {
    if (hook) {
      const r = await fetch(`${API_BASE}/api/channels`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wecom_webhook: hook })
      });
      if (!r.ok) throw new Error('保存失败');
    }

    const t = await fetch(`${API_BASE}/api/channels/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'wecom' })
    });
    const data = await t.json();

    if (data.ok) {
      showToast(data.message || '测试消息已发到企业微信群');
      wecomConfigured = true;
      stateEl.textContent = '已配置';
      stateEl.className = 'push-state on';
      input.value = '';
      input.placeholder = '已配置（留空则不修改）';
    } else {
      showToast(data.message || '发送失败');
    }
  } catch (e) {
    showToast('操作失败：' + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并测试';
  }
}
