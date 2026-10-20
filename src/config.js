import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.ZALOBOT_CONFIG || path.resolve(__dirname, '../config/config.json');
const examplePath = path.resolve(__dirname, '../config/config.example.json');

// Lần đầu chạy (vừa tải từ GitHub): tạo config/config.json từ bản mẫu. config.json không đưa lên GitHub
// vì giao diện lưu từ khóa, người gửi VIP... của từng người vào đó.
if (!process.env.ZALOBOT_CONFIG && !fs.existsSync(configPath) && fs.existsSync(examplePath)) {
    try { fs.copyFileSync(examplePath, configPath); } catch (e) { console.error('[Config] Không tạo được config.json từ bản mẫu:', e.message); }
}

export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';

const DEFAULT_CONFIG = {
    urgentKeywords: ['sập', 'gấp', 'khẩn cấp', 'lỗi', 'cháy', 'cứu'],
    vipSenders: [],
    cooldownMinutes: 3,
    enableSoundAlert: true,
    autoTaskFromAlerts: true,
    ignoreOwnMessages: true,
    timeSettings: {
        nightMode: { enabled: true, startHour: 22, endHour: 7 },
        alertSchedule: { enabled: false, activeHours: '00:00-23:59' }
    },
    ai: { enabled: true, model: DEFAULT_MODEL, scope: 'all', maxCallsPerMinute: 20 },
    // Lên lịch từ file / ảnh / tin nhắn Zalo bằng GLM (src/autoplan.js)
    autoSchedule: {
        enabled: true,
        model: 'z-ai/glm-5.3-flash',
        contextWaitSeconds: 90,
        messagesBefore: 6,
        messagesAfter: 6,
        maxFileMB: 20,
        maxFileChars: 60000,
        minConfidence: 0.6,
        scheduleFromText: true,
        maxTextCallsPerHour: 30,
        // Ghép lịch theo đoạn hội thoại: chờ ngớt N giây (tối đa M giây), gửi các tin trong X phút gần nhất
        conversationQuietSeconds: 60,
        conversationMaxWaitSeconds: 600,
        conversationWindowMinutes: 180,
        conversationMaxMessages: 25,
        ocrInlineImages: true,
        maxImagesPerHour: 60,
        ocrLang: 'en',
        // OCR Trạm 1 không với tới → gửi ảnh thẳng cho GLM (model đọc được ảnh). Ảnh trong khung chat
        // chỉ được gửi khi tin nhắn kèm có dấu hiệu lịch; file ảnh tải về / thả tay thì luôn được gửi.
        visionFallback: true
    },
    // Nhắc giờ cho mọi công việc có hạn chót (src/reminders.js) → giao diện + Yuyuko
    reminders: {
        enabled: true,
        beforeMinutes: [1440, 60, 0],
        allDayEveningBefore: '20:00',
        allDayAt: '07:00',
        yuyuko: true
    }
};

export class ConfigError extends Error {}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MODEL_ID = /^[A-Za-z0-9._\-:/~]{1,120}$/;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

let cached = null;
let cachedMtime = 0;

function withDefaults(raw) {
    const ts = isObject(raw.timeSettings) ? raw.timeSettings : {};
    return {
        ...structuredClone(DEFAULT_CONFIG),
        ...raw,
        timeSettings: {
            ...ts,
            nightMode: { ...DEFAULT_CONFIG.timeSettings.nightMode, ...ts.nightMode },
            alertSchedule: { ...DEFAULT_CONFIG.timeSettings.alertSchedule, ...ts.alertSchedule }
        },
        ai: { ...DEFAULT_CONFIG.ai, ...raw.ai },
        autoSchedule: { ...DEFAULT_CONFIG.autoSchedule, ...(isObject(raw.autoSchedule) ? raw.autoSchedule : {}) },
        reminders: { ...DEFAULT_CONFIG.reminders, ...(isObject(raw.reminders) ? raw.reminders : {}) }
    };
}

// Đọc config (gộp với giá trị mặc định để file cũ thiếu trường mới vẫn chạy).
// Cache theo thời điểm sửa file → sửa config.json (bằng tay hoặc qua giao diện) là áp dụng ngay.
export function loadConfig() {
    try {
        const { mtimeMs } = fs.statSync(configPath);
        if (cached && mtimeMs === cachedMtime) return cached;
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (!isObject(raw)) throw new Error('config.json phải là một object');
        cached = withDefaults(raw);
        cachedMtime = mtimeMs;
        return cached;
    } catch (e) {
        console.error('[Config] Không thể đọc config.json, dùng cấu hình mặc định:', e.message);
        return structuredClone(DEFAULT_CONFIG);
    }
}

function list(value, label) {
    if (!Array.isArray(value)) throw new ConfigError(`${label} phải là danh sách`);
    const out = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const s = item.trim();
        if (!s) continue;
        if (s.length > 60) throw new ConfigError(`${label} "${s.slice(0, 20)}…" quá dài (tối đa 60 ký tự)`);
        if (!out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s);
    }
    if (out.length > 200) throw new ConfigError(`${label}: tối đa 200 mục`);
    return out;
}

function int(value, min, max, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${label} phải là số nguyên từ ${min} đến ${max}`);
    return n;
}

function bool(value, label) {
    if (typeof value !== 'boolean') throw new ConfigError(`${label} phải là bật/tắt`);
    return value;
}

/**
 * Lưu cài đặt từ giao diện: chỉ nhận các trường đã biết, kiểm tra kiểu & giới hạn,
 * giữ nguyên các trường khác đang có trong file (VD: monitoredGroups).
 */
export function saveConfig(patch) {
    if (!isObject(patch)) throw new ConfigError('Dữ liệu cài đặt không hợp lệ');

    let current = {};
    try { current = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch { /* chưa có file hoặc file hỏng → dùng mặc định */ }
    const next = withDefaults(isObject(current) ? current : {});

    if ('urgentKeywords' in patch) next.urgentKeywords = list(patch.urgentKeywords, 'Từ khóa khẩn cấp');
    if ('vipSenders' in patch) next.vipSenders = list(patch.vipSenders, 'Người gửi VIP');
    if ('cooldownMinutes' in patch) next.cooldownMinutes = int(patch.cooldownMinutes, 0, 1440, 'Thời gian giãn cách');
    for (const [key, label] of [['enableSoundAlert', 'Còi báo động'], ['autoTaskFromAlerts', 'Tự tạo công việc'], ['ignoreOwnMessages', 'Bỏ qua tin của tôi']]) {
        if (key in patch) next[key] = bool(patch[key], label);
    }

    const night = patch.timeSettings?.nightMode;
    if (isObject(night)) {
        if ('enabled' in night) next.timeSettings.nightMode.enabled = bool(night.enabled, 'Chế độ ban đêm');
        if ('startHour' in night) next.timeSettings.nightMode.startHour = int(night.startHour, 0, 23, 'Giờ bắt đầu ban đêm');
        if ('endHour' in night) next.timeSettings.nightMode.endHour = int(night.endHour, 0, 23, 'Giờ kết thúc ban đêm');
    }

    const schedule = patch.timeSettings?.alertSchedule;
    if (isObject(schedule)) {
        if ('enabled' in schedule) next.timeSettings.alertSchedule.enabled = bool(schedule.enabled, 'Khung giờ cảnh báo');
        if ('activeHours' in schedule) {
            const [from, to] = String(schedule.activeHours).split('-');
            if (!HHMM.test(from || '') || !HHMM.test(to || '')) throw new ConfigError('Khung giờ cảnh báo phải có dạng HH:MM-HH:MM');
            next.timeSettings.alertSchedule.activeHours = `${from}-${to}`;
        }
    }

    const ai = patch.ai;
    if (isObject(ai)) {
        if ('enabled' in ai) next.ai.enabled = bool(ai.enabled, 'Phân tích AI');
        if ('model' in ai) {
            const model = String(ai.model ?? '').trim();
            if (!MODEL_ID.test(model)) throw new ConfigError('Tên model không hợp lệ (VD: z-ai/glm-5.3-flash)');
            next.ai.model = model;
        }
        if ('scope' in ai) {
            if (!['all', 'keywords'].includes(ai.scope)) throw new ConfigError('Phạm vi AI không hợp lệ');
            next.ai.scope = ai.scope;
        }
        if ('maxCallsPerMinute' in ai) next.ai.maxCallsPerMinute = int(ai.maxCallsPerMinute, 1, 120, 'Số lượt gọi AI mỗi phút');
    }

    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, configPath);
    cached = null;
    return loadConfig();
}
