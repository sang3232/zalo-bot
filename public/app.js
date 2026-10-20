'use strict';

/* ================= Tiện ích ================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const field = (form, name) => form.elements.namedItem(name);

// Tạo phần tử DOM. Chữ luôn được chèn dạng text node (không dùng innerHTML)
// → nội dung tin nhắn Zalo hay công việc do AI tạo không thể chèn mã HTML/JS vào trang.
function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
        if (child === undefined || child === null || child === false || child === '') continue;
        el.append(child instanceof Node ? child : String(child));
    }
    return el;
}

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const WEEKDAYS = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const PRIORITY_LABEL = { high: 'Cao', medium: 'Trung bình', low: 'Thấp' };
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const BOT_STATES = {
    starting: ['Đang khởi động', 'warn'],
    connecting: ['Đang mở Zalo Web', 'warn'],
    qr: ['Chờ quét mã QR', 'warn'],
    running: ['Đang giám sát Zalo', 'ok'],
    reconnecting: ['Đang kết nối lại', 'warn'],
    stopped: ['Đã dừng', 'danger'],
    'ui-only': ['Chỉ giao diện', 'muted']
};

function parseDue(due) {
    if (!due) return null;
    const [datePart, timePart] = due.split('T');
    const [y, m, d] = datePart.split('-').map(Number);
    if (!timePart) return new Date(y, m - 1, d, 23, 59);
    const [hh, mm] = timePart.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm);
}
const dueDay = (due) => (due ? due.slice(0, 10) : null);
const isOverdue = (task) => task.status !== 'done' && !!task.due && parseDue(task.due) < new Date();

function formatDue(due) {
    if (!due) return 'Không hạn';
    const [datePart, timePart] = due.split('T');
    const [y, m, d] = datePart.split('-');
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    let label = `${d}/${m}${Number(y) !== today.getFullYear() ? `/${y}` : ''}`;
    if (datePart === dateKey(today)) label = 'Hôm nay';
    else if (datePart === dateKey(tomorrow)) label = 'Ngày mai';
    return timePart ? `${label} ${timePart}` : label;
}

function formatTime(ts) {
    const d = new Date(ts);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return dateKey(d) === dateKey(new Date()) ? time : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`;
}

// localStorage chỉ dùng cho tuỳ chọn nhỏ của trình duyệt này (bật/tắt âm thanh trên trang)
const prefs = {
    get(key, fallback) {
        try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
        catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* bỏ qua */ }
    }
};

/* ================= Trạng thái ================= */
const startDay = new Date();
const state = {
    config: null,
    ai: null,
    bot: null,
    tasks: [],
    messages: [],
    alerts: [],
    calMonth: new Date(startDay.getFullYear(), startDay.getMonth(), 1),
    selectedDate: dateKey(startDay),
    taskFilter: 'open',
    taskSearch: '',
    editingId: null,
    settingsDirty: false
};

/* ================= Gọi API ================= */
async function api(method, url, body) {
    const options = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body ?? {});
    }
    let res;
    try {
        res = await fetch(url, options);
    } catch {
        throw new Error('Không kết nối được bot. Bot có đang chạy không?');
    }
    if (res.status === 401) {
        reloadForSession();
        throw new Error('Phiên đã hết hạn, đang tải lại trang…');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
    return data;
}

// Cookie phiên được cấp khi tải trang; nếu mất thì tải lại trang (chỉ một lần, tránh lặp vô hạn)
function reloadForSession() {
    let canReload = false;
    try {
        canReload = !sessionStorage.getItem('zb-reloaded');
        if (canReload) sessionStorage.setItem('zb-reloaded', '1');
    } catch {
        canReload = false;
    }
    if (canReload) location.reload();
}

/* ================= Thông báo ================= */
function toast(message, tone = 'info', ms = 4000) {
    const el = h('div', { class: `toast toast-${tone}`, role: 'status' }, message);
    $('#toasts').append(el);
    setTimeout(() => {
        el.classList.add('is-leaving');
        setTimeout(() => el.remove(), 300);
    }, ms);
}

let audioCtx = null;
function ensureAudio() {
    try {
        audioCtx ||= new AudioContext();
        if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch { audioCtx = null; }
}

function playAlarm() {
    ensureAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    [880, 1175, 1568].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const start = t0 + i * 0.22;
        osc.type = 'square';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(start);
        osc.stop(start + 0.21);
    });
}

function notifyAlert(alert) {
    toast(`🚨 ${alert.sender}: ${alert.content}`, 'danger', 10000);
    if (prefs.get('uiSound', true)) playAlarm();
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        try {
            new Notification(`🚨 Tin khẩn từ ${alert.sender}`, { body: alert.content.slice(0, 180), tag: alert.id });
        } catch { /* bỏ qua */ }
    }
}

// Nhắc lịch / đã lên lịch từ file, ảnh / file cần tải (src/reminders.js, src/autoplan.js)
function playChime() {
    ensureAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    [659, 880].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const start = t0 + i * 0.3;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.15, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(start);
        osc.stop(start + 0.55);
    });
}

function notifyNotice(notice) {
    const isReminder = notice.kind === 'reminder';
    const text = notice.body ? `${notice.title}: ${notice.body}` : notice.title;
    const tone = { reminder: 'warn', cancelled: 'warn', 'need-file': 'info' }[notice.kind] || 'ok';
    toast(text, tone, isReminder ? 20000 : 10000);
    if (isReminder && prefs.get('uiSound', true)) playChime();
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        try {
            new Notification(notice.title, { body: String(notice.body || '').slice(0, 180), tag: `${notice.kind}-${notice.taskId || notice.at}` });
        } catch { /* bỏ qua */ }
    }
}

/* ================= Hiển thị: trạng thái ================= */
function renderStatus() {
    const [label, tone] = BOT_STATES[state.bot?.state] || ['Không rõ', 'muted'];
    $('#botDot').dataset.tone = tone;
    $('#botText').textContent = label;
    $('#botText').title = state.bot?.detail || '';

    const ai = state.ai;
    let aiLabel = 'AI: tắt';
    let aiTone = 'muted';
    if (ai?.enabled && !ai.hasKey) { aiLabel = 'AI: chưa có API key'; aiTone = 'warn'; }
    else if (ai?.enabled && ai.lastError) { aiLabel = 'AI: có lỗi gần đây'; aiTone = 'danger'; }
    else if (ai?.enabled) { aiLabel = `AI: ${ai.model}`; aiTone = 'ok'; }
    $('#aiDot').dataset.tone = aiTone;
    $('#aiText').textContent = aiLabel;
    $('#aiText').title = ai?.lastError || '';

    const pill = $('#keyPill');
    pill.textContent = ai?.hasKey ? `Đã lưu: ${ai.maskedKey}${ai.keyFromEnv ? ' (từ .env)' : ''}` : 'Chưa có key';
    pill.dataset.tone = ai?.hasKey ? 'ok' : 'warn';

    renderBanner();
}

function renderBanner() {
    const banner = $('#botBanner');
    const detail = state.bot?.detail ? ` ${state.bot.detail}.` : '';
    const messages = {
        qr: ['warn', `Bot đang chờ quét mã QR Zalo.${detail}`],
        reconnecting: ['warn', `Mất kết nối Zalo Web, đang thử lại…${detail}`],
        stopped: ['danger', 'Bot đã dừng giám sát Zalo. Hãy chạy lại start-zalobot.bat.'],
        'ui-only': ['muted', 'Đang chạy chế độ chỉ giao diện: không đọc tin nhắn Zalo. Dùng ô "Thử bộ lọc" để kiểm tra.']
    };
    const entry = messages[state.bot?.state];
    banner.hidden = !entry;
    if (entry) {
        banner.dataset.tone = entry[0];
        banner.textContent = entry[1];
    }
}

function setConnection(ok) {
    $('#connDot').dataset.tone = ok ? 'ok' : 'danger';
    $('#connText').textContent = ok ? 'Máy chủ: đã kết nối' : 'Máy chủ: mất kết nối, đang thử lại…';
}

/* ================= Hiển thị: tổng quan ================= */
const emptyItem = (text) => h('li', { class: 'empty' }, text);

function badge(text, cls = '') {
    return h('span', { class: `badge ${cls}` }, text);
}

function alertItem(alert) {
    return h('li', { class: 'feed-item is-alert' },
        h('div', { class: 'feed-meta' },
            h('span', { class: 'feed-time' }, formatTime(alert.at)),
            h('strong', {}, alert.sender),
            alert.isTest && badge('Thử'),
            alert.source === 'ai' && badge('AI', 'tone-ai')),
        h('p', { class: 'feed-text' }, alert.content),
        h('p', { class: 'feed-reason' }, alert.reason));
}

function messageItem(msg) {
    return h('li', { class: `feed-item${msg.urgent ? ' is-urgent' : ''}`, title: msg.reason || '' },
        h('div', { class: 'feed-meta' },
            h('span', { class: 'feed-time' }, formatTime(msg.at)),
            h('strong', {}, msg.sender),
            msg.isGroup && msg.groupName && msg.groupName !== msg.sender && h('span', { class: 'muted' }, `· ${msg.groupName}`),
            msg.isTest && badge('Thử'),
            msg.urgent && badge(msg.alerted ? 'Đã báo động' : 'Khẩn', 'tone-danger'),
            msg.source === 'ai' && badge('AI', 'tone-ai')),
        h('p', { class: 'feed-text' }, msg.content),
        msg.urgent && msg.reason && h('p', { class: 'feed-reason' }, msg.reason));
}

function renderStats() {
    const today = dateKey(new Date());
    const isToday = (ts) => dateKey(new Date(ts)) === today;
    const open = state.tasks.filter(t => t.status !== 'done');
    $('#statMessages').textContent = state.messages.filter(m => isToday(m.at)).length;
    $('#statAlerts').textContent = state.alerts.filter(a => isToday(a.at)).length;
    $('#statOpen').textContent = open.length;
    $('#statOverdue').textContent = open.filter(isOverdue).length;
}

function renderOverview() {
    const now = new Date();
    $('#todayText').textContent = `${WEEKDAYS[now.getDay()]}, ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    renderStats();

    const alerts = state.alerts.slice(-30).reverse();
    $('#alertList').replaceChildren(...(alerts.length ? alerts.map(alertItem) : [emptyItem('Chưa có cảnh báo nào')]));

    const messages = state.messages.slice(-60).reverse();
    $('#messageList').replaceChildren(...(messages.length
        ? messages.map(messageItem)
        : [emptyItem('Chưa có tin nhắn mới. Tin sẽ hiện ở đây ngay khi Zalo nhận được.')]));
}

function renderTestResult(decision) {
    const box = $('#testResult');
    let title;
    let tone;
    if (decision.alerted) { title = '🚨 Khẩn cấp — đã báo động'; tone = 'danger'; }
    else if (decision.urgent && decision.coolingDown) { title = '⏳ Khẩn cấp, nhưng đang trong thời gian giãn cách'; tone = 'warn'; }
    else if (decision.urgent && decision.outsideSchedule) { title = '🌙 Khẩn cấp, nhưng ngoài khung giờ cảnh báo'; tone = 'warn'; }
    else { title = '✅ Tin bình thường — không báo động'; tone = 'ok'; }

    box.dataset.tone = tone;
    // replaceChildren() biến null thành chữ "null" → lọc bỏ phần tử không có
    box.replaceChildren(...[
        h('strong', {}, title),
        decision.reason && h('p', {}, decision.reason),
        h('p', { class: 'muted small' }, decision.source === 'ai' ? 'Quyết định bởi AI (OpenRouter)' : 'Quyết định bởi bộ lọc từ khóa / VIP'),
        decision.task && h('p', { class: 'small' }, `📌 Đã tạo công việc: ${decision.task.title} · ${formatDue(decision.task.due)}`)
    ].filter(Boolean));
    box.hidden = false;
}

/* ================= Hiển thị: công việc ================= */
function taskItem(task, compact = false) {
    const overdue = isOverdue(task);
    const check = h('input', { type: 'checkbox', class: 'task-check', 'aria-label': 'Đánh dấu đã xong', dataset: { action: 'toggle', id: task.id } });
    check.checked = task.status === 'done';
    const source = task.source || {};

    return h('li', { class: `task-item prio-${task.priority}${task.status === 'done' ? ' is-done' : ''}` },
        check,
        h('div', { class: 'task-body' },
            h('div', { class: 'task-title' }, task.title),
            h('div', { class: 'task-meta' },
                badge(overdue ? `Quá hạn · ${formatDue(task.due)}` : formatDue(task.due), overdue ? 'tone-danger' : ''),
                !compact && badge(PRIORITY_LABEL[task.priority] || task.priority, `prio-${task.priority}`),
                task.status === 'doing' && badge('Đang làm', 'tone-primary'),
                source.type === 'zalo' && h('span', { class: 'badge tone-ai', title: source.content || '' }, `🤖 Zalo · ${source.sender || ''}`),
                source.type === 'alert' && h('span', { class: 'badge tone-danger', title: source.content || '' }, `🚨 ${source.sender || ''}`),
                source.type === 'lich' && h('span', { class: 'badge tone-ai', title: source.content || '' },
                    `${source.kind === 'anh' ? '🖼️ Ảnh' : source.file ? `📎 ${source.file}` : '🗓️ Zalo'}${source.sender ? ` · ${source.sender}` : ''}`),
                source.isTest && badge('Thử')),
            !compact && task.note && h('p', { class: 'task-note' }, task.note)),
        h('div', { class: 'task-actions' },
            h('button', { type: 'button', class: 'icon-btn', title: 'Sửa', 'aria-label': 'Sửa', dataset: { action: 'edit', id: task.id } }, '✎'),
            h('button', { type: 'button', class: 'icon-btn danger', title: 'Xoá', 'aria-label': 'Xoá', dataset: { action: 'delete', id: task.id } }, '✕')));
}

function sortTasks(list) {
    const dueValue = (t) => (t.due ? parseDue(t.due).getTime() : Number.POSITIVE_INFINITY);
    return list.sort((a, b) =>
        (a.status === 'done') - (b.status === 'done')
        || (dueValue(a) === dueValue(b) ? 0 : dueValue(a) < dueValue(b) ? -1 : 1)
        || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
        || String(b.createdAt).localeCompare(String(a.createdAt)));
}

function renderTasks() {
    const today = dateKey(new Date());
    const query = state.taskSearch.trim().toLowerCase();
    let list = state.tasks.filter(t => {
        switch (state.taskFilter) {
            case 'open': return t.status !== 'done';
            case 'today': return dueDay(t.due) === today;
            case 'overdue': return isOverdue(t);
            case 'done': return t.status === 'done';
            default: return true;
        }
    });
    if (query) {
        list = list.filter(t => `${t.title} ${t.note} ${t.source?.sender || ''}`.toLowerCase().includes(query));
    }
    const emptyText = query ? 'Không tìm thấy việc nào' : {
        open: 'Không còn việc nào chưa xong 🎉',
        today: 'Hôm nay không có việc nào',
        overdue: 'Không có việc quá hạn',
        done: 'Chưa có việc nào xong',
        all: 'Chưa có công việc. Bấm "+ Thêm việc" để tạo.'
    }[state.taskFilter];

    $('#taskList').replaceChildren(...(list.length ? sortTasks(list).map(t => taskItem(t)) : [emptyItem(emptyText)]));
    $$('#taskFilter button').forEach(b => b.classList.toggle('is-active', b.dataset.filter === state.taskFilter));
}

function renderTaskBadge() {
    const count = state.tasks.filter(t => t.status !== 'done').length;
    const el = $('#taskCount');
    el.textContent = count;
    el.hidden = count === 0;
}

function openTaskForm(task = null, presetDate = null) {
    const form = $('#taskForm');
    state.editingId = task?.id || null;
    $('#taskFormTitle').textContent = task ? 'Sửa công việc' : 'Thêm công việc';
    const [datePart, timePart] = (task?.due || '').split('T');
    field(form, 'title').value = task?.title || '';
    field(form, 'note').value = task?.note || '';
    field(form, 'date').value = datePart || presetDate || '';
    field(form, 'time').value = timePart || '';
    field(form, 'priority').value = task?.priority || 'medium';
    field(form, 'status').value = task?.status || 'todo';
    form.hidden = false;
    showView('tasks');
    field(form, 'title').focus();
}

function closeTaskForm() {
    $('#taskForm').hidden = true;
    $('#taskForm').reset();
    state.editingId = null;
}

function upsertTask(task) {
    if (!task) return;
    const index = state.tasks.findIndex(t => t.id === task.id);
    if (index === -1) state.tasks.push(task);
    else state.tasks[index] = task;
    renderTaskViews();
}

function removeTask(id) {
    state.tasks = state.tasks.filter(t => t.id !== id);
    renderTaskViews();
}

function renderTaskViews() {
    renderTaskBadge();
    renderStats();
    renderCalendar();
    renderTasks();
}

/* ================= Hiển thị: lịch ================= */
function tasksByDay() {
    const map = new Map();
    for (const task of state.tasks) {
        const day = dueDay(task.due);
        if (!day) continue;
        if (!map.has(day)) map.set(day, []);
        map.get(day).push(task);
    }
    for (const list of map.values()) sortTasks(list);
    return map;
}

function renderCalendar() {
    const month = state.calMonth;
    $('#calTitle').textContent = `Tháng ${month.getMonth() + 1}, ${month.getFullYear()}`;
    const offset = (month.getDay() + 6) % 7; // Lịch bắt đầu từ Thứ Hai
    const byDay = tasksByDay();
    const todayKey = dateKey(new Date());
    const cells = [];

    for (let i = 0; i < 42; i++) {
        const day = new Date(month.getFullYear(), month.getMonth(), 1 - offset + i);
        const key = dateKey(day);
        const dayTasks = byDay.get(key) || [];
        const classes = ['cal-cell'];
        if (day.getMonth() !== month.getMonth()) classes.push('is-other');
        if (key === todayKey) classes.push('is-today');
        if (key === state.selectedDate) classes.push('is-selected');

        cells.push(h('button', {
            type: 'button',
            class: classes.join(' '),
            dataset: { date: key },
            'aria-label': `${WEEKDAYS[day.getDay()]} ${day.getDate()}/${day.getMonth() + 1}: ${dayTasks.length} việc`,
            'aria-pressed': key === state.selectedDate ? 'true' : 'false'
        },
            h('span', { class: 'cal-day' }, day.getDate()),
            h('span', { class: 'cal-chips' },
                dayTasks.slice(0, 3).map(t => h('span', {
                    class: `chip prio-${t.priority}${t.status === 'done' ? ' is-done' : ''}`,
                    title: t.title
                }, `${t.due.includes('T') ? `${t.due.slice(11)} ` : ''}${t.title}`)),
                dayTasks.length > 3 && h('span', { class: 'chip more' }, `+${dayTasks.length - 3} việc`)),
            dayTasks.length > 0 && h('span', { class: 'cal-dots' }, dayTasks.slice(0, 4).map(t => h('i', { class: `prio-${t.priority}` })))
        ));
    }

    $('#calGrid').replaceChildren(...cells);
    renderDayPanel(byDay);
}

function renderDayPanel(byDay = tasksByDay()) {
    const [y, m, d] = state.selectedDate.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    $('#dayTitle').textContent = `${WEEKDAYS[date.getDay()]}, ${pad(d)}/${pad(m)}/${y}`;
    const list = byDay.get(state.selectedDate) || [];
    $('#dayTasks').replaceChildren(...(list.length ? list.map(t => taskItem(t, true)) : [emptyItem('Không có việc nào trong ngày này')]));
}

function shiftMonth(delta) {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + delta, 1);
    renderCalendar();
}

/* ================= Cài đặt ================= */
function fillSettings(config) {
    const form = $('#settingsForm');
    const set = (name, value) => { field(form, name).value = value ?? ''; };
    const check = (name, value) => { field(form, name).checked = !!value; };
    const schedule = config.timeSettings?.alertSchedule || {};
    const night = config.timeSettings?.nightMode || {};
    const [from, to] = String(schedule.activeHours || '00:00-23:59').split('-');

    check('aiEnabled', config.ai?.enabled);
    set('aiModel', config.ai?.model);
    set('aiScope', config.ai?.scope || 'all');
    set('aiMax', config.ai?.maxCallsPerMinute);
    set('urgentKeywords', (config.urgentKeywords || []).join('\n'));
    set('vipSenders', (config.vipSenders || []).join('\n'));
    set('cooldownMinutes', config.cooldownMinutes);
    check('enableSoundAlert', config.enableSoundAlert !== false);
    check('autoTaskFromAlerts', config.autoTaskFromAlerts);
    check('ignoreOwnMessages', config.ignoreOwnMessages);
    check('scheduleEnabled', schedule.enabled);
    set('alertFrom', from);
    set('alertTo', to);
    check('nightEnabled', night.enabled);
    set('nightStart', night.startHour);
    set('nightEnd', night.endHour);

    state.settingsDirty = false;
    $('#saveState').textContent = '';
}

function collectSettings() {
    const form = $('#settingsForm');
    const lines = (name) => field(form, name).value.split('\n').map(s => s.trim()).filter(Boolean);
    const num = (name) => Number(field(form, name).value);
    const checked = (name) => field(form, name).checked;
    const from = field(form, 'alertFrom').value || '00:00';
    const to = field(form, 'alertTo').value || '23:59';

    return {
        urgentKeywords: lines('urgentKeywords'),
        vipSenders: lines('vipSenders'),
        cooldownMinutes: num('cooldownMinutes'),
        enableSoundAlert: checked('enableSoundAlert'),
        autoTaskFromAlerts: checked('autoTaskFromAlerts'),
        ignoreOwnMessages: checked('ignoreOwnMessages'),
        timeSettings: {
            nightMode: { enabled: checked('nightEnabled'), startHour: num('nightStart'), endHour: num('nightEnd') },
            alertSchedule: { enabled: checked('scheduleEnabled'), activeHours: `${from.slice(0, 5)}-${to.slice(0, 5)}` }
        },
        ai: {
            enabled: checked('aiEnabled'),
            model: field(form, 'aiModel').value.trim(),
            scope: field(form, 'aiScope').value,
            maxCallsPerMinute: num('aiMax')
        }
    };
}

function renderNotifyState() {
    const el = $('#notifyState');
    const btn = $('#notifyBtn');
    if (!('Notification' in window)) {
        el.textContent = 'Trình duyệt không hỗ trợ thông báo';
        btn.disabled = true;
        return;
    }
    el.textContent = {
        granted: 'Đã bật — sẽ hiện thông báo khi tab này đang ẩn',
        denied: 'Đã bị chặn — bật lại trong cài đặt trang của trình duyệt',
        default: 'Chưa bật'
    }[Notification.permission] || '';
    btn.disabled = Notification.permission !== 'default';
}

/* ================= Điều hướng ================= */
function showView(name) {
    if (!document.getElementById(`view-${name}`)) name = 'overview';
    $$('.view').forEach(v => v.classList.toggle('is-active', v.id === `view-${name}`));
    $$('.nav-item').forEach(b => {
        const active = b.dataset.view === name;
        b.classList.toggle('is-active', active);
        if (active) b.setAttribute('aria-current', 'page');
        else b.removeAttribute('aria-current');
    });
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}

/* ================= Sự kiện ================= */
function bindEvents() {
    $$('.nav-item').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));
    window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
    document.addEventListener('pointerdown', ensureAudio, { once: true });

    // Thử bộ lọc
    $('#testForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Đang phân tích…';
        try {
            const { decision } = await api('POST', '/api/test-message', {
                sender: field(form, 'sender').value,
                content: field(form, 'content').value,
                isGroup: field(form, 'isGroup').checked
            });
            renderTestResult(decision);
        } catch (err) {
            toast(err.message, 'danger');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Phân tích';
        }
    });

    // Lịch
    $('#calPrev').addEventListener('click', () => shiftMonth(-1));
    $('#calNext').addEventListener('click', () => shiftMonth(1));
    $('#calToday').addEventListener('click', () => {
        const now = new Date();
        state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        state.selectedDate = dateKey(now);
        renderCalendar();
    });
    $('#calGrid').addEventListener('click', (e) => {
        const cell = e.target.closest('.cal-cell');
        if (!cell) return;
        state.selectedDate = cell.dataset.date;
        const [y, m] = cell.dataset.date.split('-').map(Number);
        if (y !== state.calMonth.getFullYear() || m - 1 !== state.calMonth.getMonth()) {
            state.calMonth = new Date(y, m - 1, 1);
        }
        renderCalendar();
    });
    $('#dayForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const time = field(form, 'time').value;
        try {
            const { task } = await api('POST', '/api/tasks', {
                title: field(form, 'title').value,
                priority: field(form, 'priority').value,
                due: time ? `${state.selectedDate}T${time.slice(0, 5)}` : state.selectedDate
            });
            upsertTask(task);
            form.reset();
            toast('Đã thêm việc', 'ok', 2000);
        } catch (err) {
            toast(err.message, 'danger');
        }
    });

    // Công việc
    $('#newTaskBtn').addEventListener('click', () => openTaskForm(null));
    $('#taskCancel').addEventListener('click', closeTaskForm);
    $('#taskForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const date = field(form, 'date').value;
        const time = field(form, 'time').value;
        if (time && !date) {
            toast('Hãy chọn ngày cho hạn chót', 'warn');
            return;
        }
        const body = {
            title: field(form, 'title').value,
            note: field(form, 'note').value,
            due: date ? (time ? `${date}T${time.slice(0, 5)}` : date) : null,
            priority: field(form, 'priority').value,
            status: field(form, 'status').value
        };
        const editing = state.editingId;
        try {
            const { task } = editing
                ? await api('PATCH', `/api/tasks/${editing}`, body)
                : await api('POST', '/api/tasks', body);
            upsertTask(task);
            closeTaskForm();
            toast(editing ? 'Đã lưu thay đổi' : 'Đã thêm việc', 'ok', 2000);
        } catch (err) {
            toast(err.message, 'danger');
        }
    });
    $('#taskFilter').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-filter]');
        if (!btn) return;
        state.taskFilter = btn.dataset.filter;
        renderTasks();
    });
    $('#taskSearch').addEventListener('input', (e) => {
        state.taskSearch = e.target.value;
        renderTasks();
    });

    // Nút sửa / xoá / đánh dấu xong (dùng chung cho danh sách công việc và lịch)
    document.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        const task = state.tasks.find(t => t.id === btn.dataset.id);
        if (!task) return;
        if (btn.dataset.action === 'edit') openTaskForm(task);
        if (btn.dataset.action === 'delete') {
            if (!confirm(`Xoá công việc "${task.title}"?`)) return;
            try {
                await api('DELETE', `/api/tasks/${task.id}`);
                removeTask(task.id);
                toast('Đã xoá', 'ok', 2000);
            } catch (err) {
                toast(err.message, 'danger');
            }
        }
    });
    document.addEventListener('change', async (e) => {
        const box = e.target.closest('input[data-action="toggle"]');
        if (!box) return;
        try {
            const { task } = await api('PATCH', `/api/tasks/${box.dataset.id}`, { status: box.checked ? 'done' : 'todo' });
            upsertTask(task);
        } catch (err) {
            box.checked = !box.checked;
            toast(err.message, 'danger');
        }
    });

    // OpenRouter key
    $('#keyForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = $('#keyInput');
        const key = input.value.trim();
        if (!key) {
            toast('Dán API key vào ô trước đã', 'warn');
            return;
        }
        try {
            const { ai } = await api('PUT', '/api/openrouter/key', { key });
            input.value = '';
            state.ai = ai;
            renderStatus();
            toast('Đã lưu API key', 'ok');
        } catch (err) {
            toast(err.message, 'danger');
        }
    });
    $('#keyTest').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const out = $('#keyResult');
        btn.disabled = true;
        out.hidden = false;
        out.dataset.tone = 'warn';
        out.textContent = 'Đang gọi thử OpenRouter…';
        try {
            const result = await api('POST', '/api/openrouter/test', { model: field($('#settingsForm'), 'aiModel').value.trim() });
            out.dataset.tone = result.ok ? 'ok' : 'danger';
            out.textContent = result.ok
                ? `✅ Kết nối thành công · model ${result.model} · ${result.latencyMs} ms`
                : `❌ ${result.error}`;
        } catch (err) {
            out.dataset.tone = 'danger';
            out.textContent = `❌ ${err.message}`;
        } finally {
            btn.disabled = false;
        }
    });
    $('#keyDelete').addEventListener('click', async () => {
        if (!state.ai?.hasKey) {
            toast('Chưa có key để xoá', 'warn');
            return;
        }
        if (!confirm('Xoá API key OpenRouter khỏi máy này?')) return;
        try {
            const { ai } = await api('DELETE', '/api/openrouter/key');
            state.ai = ai;
            renderStatus();
            $('#keyResult').hidden = true;
            toast('Đã xoá API key', 'ok');
        } catch (err) {
            toast(err.message, 'danger');
        }
    });

    // Cài đặt
    const settingsForm = $('#settingsForm');
    settingsForm.addEventListener('input', () => {
        state.settingsDirty = true;
        $('#saveState').textContent = 'Có thay đổi chưa lưu';
    });
    settingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = settingsForm.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
            const { config } = await api('PUT', '/api/config', collectSettings());
            state.config = config;
            fillSettings(config);
            toast('Đã lưu cài đặt — bot áp dụng ngay', 'ok');
        } catch (err) {
            $('#saveState').textContent = err.message;
            toast(err.message, 'danger', 6000);
        } finally {
            btn.disabled = false;
        }
    });

    // Thông báo trình duyệt
    $('#notifyBtn').addEventListener('click', async () => {
        try { await Notification.requestPermission(); } catch { /* bỏ qua */ }
        renderNotifyState();
    });
    $('#uiSound').checked = prefs.get('uiSound', true);
    $('#uiSound').addEventListener('change', (e) => {
        prefs.set('uiSound', e.target.checked);
        if (e.target.checked) playAlarm();
    });
}

/* ================= Dữ liệu thời gian thực ================= */
async function loadState() {
    const data = await api('GET', '/api/state');
    Object.assign(state, {
        config: data.config,
        ai: data.ai,
        bot: data.bot,
        tasks: data.tasks || [],
        messages: data.messages || [],
        alerts: data.alerts || []
    });
    try { sessionStorage.removeItem('zb-reloaded'); } catch { /* bỏ qua */ }
    if (!state.settingsDirty) fillSettings(state.config);
    renderAll();
}

function connectEvents() {
    const source = new EventSource('/api/events');
    let opened = false;
    source.addEventListener('open', () => {
        setConnection(true);
        // Kết nối lại sau khi bot khởi động lại → tải lại toàn bộ dữ liệu
        if (opened) loadState().catch(err => toast(err.message, 'danger'));
        opened = true;
    });
    source.addEventListener('error', () => setConnection(false));

    const on = (name, handler) => source.addEventListener(name, (e) => {
        try { handler(JSON.parse(e.data)); } catch (err) { console.error(err); }
    });
    on('chat', (msg) => {
        state.messages.push(msg);
        if (state.messages.length > 300) state.messages.shift();
        renderOverview();
    });
    on('chat-update', (msg) => {
        const index = state.messages.findIndex(m => m.id === msg.id);
        if (index > -1) state.messages[index] = msg;
        renderOverview();
    });
    on('alert', (alert) => {
        state.alerts.push(alert);
        renderOverview();
        notifyAlert(alert);
    });
    on('notice', notifyNotice);
    on('tasks', (tasks) => {
        state.tasks = tasks;
        renderTaskViews();
    });
    on('status', (bot) => {
        state.bot = bot;
        renderStatus();
    });
    on('ai', (ai) => {
        state.ai = ai;
        renderStatus();
    });
    on('config', (config) => {
        state.config = config;
        if (!state.settingsDirty) fillSettings(config);
    });
}

function renderAll() {
    renderStatus();
    renderOverview();
    renderTaskViews();
}

document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    showView(location.hash.slice(1) || 'overview');
    renderNotifyState();
    renderCalendar();
    try {
        await loadState();
    } catch (err) {
        toast(err.message, 'danger', 8000);
    }
    connectEvents();
    // Cập nhật "quá hạn", "hôm nay"... mỗi phút
    setInterval(renderAll, 60000);
});
