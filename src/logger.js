import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logsDir = process.env.ZALOBOT_LOG_DIR || path.resolve(__dirname, '../logs');

// Đảm bảo thư mục logs luôn tồn tại
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const appLogPath = path.join(logsDir, 'app.log');
const alertsLogPath = path.join(logsDir, 'alerts.log');

// FIX: Dùng giờ máy (giờ Việt Nam). toISOString() trả giờ UTC → log lệch 7 tiếng
//      (VD: alerts.log ghi 14:34 trong khi tin nhắn gửi lúc 21:37)
function getFormattedTime() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function appendToFile(filePath, text) {
    try {
        fs.appendFileSync(filePath, text + '\n', 'utf-8');
    } catch (e) {
        console.error('[Logger Error] Không thể ghi file log:', e.message);
    }
}

export const logger = {
    info(msg) {
        const time = getFormattedTime();
        const line = `[${time}] [INFO] ${msg}`;
        console.log(line);
        appendToFile(appLogPath, line);
    },

    message(sender, content, isGroup = false, groupName = '') {
        const time = getFormattedTime();
        const groupTag = isGroup ? ` [Nhóm: ${groupName}]` : '';
        const line = `[${time}] [TIN NHẮN] 💬 ${sender}${groupTag}: ${content}`;
        console.log(line);
        appendToFile(appLogPath, line);
    },

    warn(msg) {
        const time = getFormattedTime();
        const line = `[${time}] [CẢNH BÁO] ⚠️ ${msg}`;
        console.warn(line);
        appendToFile(appLogPath, line);
    },

    error(msg, error = '') {
        const time = getFormattedTime();
        const line = `[${time}] [LỖI] ❌ ${msg} ${error ? `-> ${error}` : ''}`;
        console.error(line);
        appendToFile(appLogPath, line);
    },

    alert(alertData) {
        const time = getFormattedTime();
        const { sender, content, urgencyReason, isTest } = alertData;

        const summary = `
============================================================
🚨 [${time}] ${isTest ? '[THỬ] ' : ''}BÁO ĐỘNG KHẨN CẤP
👤 Người gửi : ${sender}
💬 Nội dung  : ${content}
🔍 Lý do     : ${urgencyReason}
🔔 Báo động  : còi máy tính + giao diện quản lý
============================================================`;

        console.log(summary);
        appendToFile(appLogPath, summary);
        // Tin thử từ giao diện không ghi vào alerts.log (chỉ giữ báo động thật)
        if (!isTest) appendToFile(alertsLogPath, summary);
    }
};
