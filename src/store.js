import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Lưu dữ liệu của bot dạng JSON trong thư mục data/ (nằm trong .gitignore):
 *   secrets.json        API key OpenRouter, token phiên của giao diện
 *   tasks.json          Công việc / lịch
 *   history.json        Tin nhắn & cảnh báo gần đây (cho giao diện)
 *   seen-messages.json  Dấu vân tay tin đã thấy (chống báo lại tin cũ sau khi khởi động lại)
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.ZALOBOT_DATA_DIR || path.resolve(__dirname, '../data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const SECRETS_FILE = 'secrets.json';
const pendingWriters = new Set();

export function readJson(name, fallback) {
    const file = path.join(DATA_DIR, name);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf-8');
    } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[Store] Không đọc được ${name}:`, e.message);
        return fallback;
    }
    try {
        return JSON.parse(raw);
    } catch (e) {
        // Giữ lại file hỏng thay vì ghi đè làm mất dữ liệu
        const backup = `${file}.corrupt-${Date.now()}`;
        try { fs.renameSync(file, backup); } catch { /* bỏ qua */ }
        console.error(`[Store] ${name} bị hỏng, đã đổi tên thành ${path.basename(backup)}:`, e.message);
        return fallback;
    }
}

// Ghi qua file tạm rồi đổi tên → không bao giờ để lại file JSON ghi dở
export function writeJson(name, value) {
    const file = path.join(DATA_DIR, name);
    const tmp = `${file}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
        fs.renameSync(tmp, file);
    } catch (e) {
        console.error(`[Store] Không ghi được ${name}:`, e.message);
    }
}

/** Gộp nhiều lần ghi liên tiếp thành một (cho dữ liệu thay đổi liên tục) */
export function debouncedWriter(name, getValue, delayMs = 1500) {
    let timer = null;
    const writer = {
        schedule() {
            if (timer) return;
            pendingWriters.add(writer);
            timer = setTimeout(writer.flush, delayMs);
        },
        flush() {
            if (!timer) return;
            clearTimeout(timer);
            timer = null;
            pendingWriters.delete(writer);
            writeJson(name, getValue());
        }
    };
    return writer;
}

export function flushPending() {
    for (const writer of [...pendingWriters]) writer.flush();
}

// Ghi nốt dữ liệu đang chờ khi tắt bot
process.on('exit', flushPending);

export function getSecret(name) {
    const secrets = readJson(SECRETS_FILE, {});
    const value = secrets && typeof secrets === 'object' ? secrets[name] : null;
    return typeof value === 'string' && value ? value : null;
}

export function setSecret(name, value) {
    const current = readJson(SECRETS_FILE, {});
    const secrets = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    if (value) secrets[name] = value;
    else delete secrets[name];
    writeJson(SECRETS_FILE, secrets);
}
