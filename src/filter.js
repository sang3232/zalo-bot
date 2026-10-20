import { loadConfig } from './config.js';

export { loadConfig };

export function removeVietnameseTones(str) {
    // FIX: normalize NFC để xử lý cả tiếng Việt gõ bằng Unicode tổ hợp (NFD)
    str = String(str ?? '').normalize('NFC').toLowerCase();
    str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, "a");
    str = str.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, "e");
    str = str.replace(/ì|í|ị|ỉ|ĩ/g, "i");
    str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, "o");
    str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, "u");
    str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, "y");
    str = str.replace(/đ/g, "d");
    return str;
}

// Các chữ cái có dấu tiếng Việt — dùng để biết một từ có được gõ dấu hay không
const VIETNAMESE_TONE_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/;

function tokenize(text) {
    return String(text ?? '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * So khớp 1 từ trong tin nhắn với 1 từ trong từ khóa:
 * - Giống hệt nhau (kể cả dấu), hoặc
 * - Từ trong tin nhắn được gõ KHÔNG dấu và trùng với từ khóa sau khi bỏ dấu ("sap" ~ "sập")
 * FIX: Trước đây bỏ dấu cả 2 phía rồi so chuỗi con → "sắp" khớp "sập", "gặp" khớp "gấp",
 *      "lời"/"lợi" khớp "lỗi", "Khang"/"khăn" khớp "khẩn", "cửu" khớp "cứu" → gọi điện nhầm.
 */
function wordMatches(msgWord, kwWord) {
    if (msgWord === kwWord) return true;
    return !VIETNAMESE_TONE_CHARS.test(msgWord) && msgWord === removeVietnameseTones(kwWord);
}

/**
 * Kiểm tra `text` có chứa cụm từ `phrase` hay không (so theo nguyên từ, không so chuỗi con)
 */
function containsPhrase(text, phrase) {
    const words = tokenize(text);
    const phraseWords = tokenize(phrase);
    if (phraseWords.length === 0) return false;

    for (let i = 0; i + phraseWords.length <= words.length; i++) {
        if (phraseWords.every((w, j) => wordMatches(words[i + j], w))) return true;
    }
    return false;
}

// Lưu thời điểm báo động gần nhất của từng người gửi / nhóm (Cooldown)
const cooldownMap = new Map();

/**
 * Kiểm tra xem hiện tại có phải là khung giờ ban đêm không
 */
function isNightTime(config) {
    const nightMode = config.timeSettings?.nightMode;
    if (!nightMode || !nightMode.enabled) return false;

    const currentHour = new Date().getHours();
    const startHour = nightMode.startHour ?? 22;
    const endHour = nightMode.endHour ?? 7;

    if (startHour > endHour) {
        // Ví dụ: 22h tối đến 7h sáng hôm sau
        return currentHour >= startHour || currentHour < endHour;
    } else {
        return currentHour >= startHour && currentHour < endHour;
    }
}

/**
 * Kiểm tra xem nội dung tin nhắn có phải là nhãn ngày tháng cũ của Zalo
 * CHỈ match khi toàn bộ nội dung (hoặc phần lớn) là nhãn ngày - KHÔNG match nội dung chat thông thường
 * FIX: Regex trước đó quá rộng, gây dương tính giả (VD: "bán 2/3 lô" bị xem là ngày cũ)
 */
function isZaloDateLabel(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    // Chỉ match khi toàn bộ chuỗi là nhãn ngày thuần (không phải nội dung chat)
    // VD: "Hôm qua", "15/07/2026", "Thứ Hai 15/07", "2 ngày trước"
    const pureDatePatterns = [
        /^hôm qua$/i,
        /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/,                      // "15/07" hoặc "15/07/2026" (đứng riêng)
        /^\d{1,2}\s+tháng\s+\d{1,2}$/i,                         // "15 tháng 07"
        /^thứ\s+(?:hai|ba|tư|năm|sáu|bảy|chủ nhật)$/i,         // "Thứ Hai" (đứng riêng)
        /^\d+\s+(?:ngày|tháng|tuần|năm)\s+trước$/i,             // "2 ngày trước", "1 tháng trước"
        /^(?:ngày|tháng|tuần|năm)\s+trước$/i,                   // "ngày trước", "tháng trước"
    ];
    return pureDatePatterns.some(p => p.test(trimmed));
}

/**
 * Phân loại tin nhắn theo từ khóa / người gửi VIP (chưa xét cooldown)
 * @returns {{ isUrgent: boolean, reason: string, matchedVip: string|null, matchedKeyword: string|null, isNight: boolean }}
 */
export function classifyMessage(message, config = loadConfig()) {
    const { sender = '', content = '', isGroup = false, groupName = '' } = message;
    const isNight = isNightTime(config);
    const normal = (reason) => ({ isUrgent: false, reason, matchedVip: null, matchedKeyword: null, isNight });

    if (!content || typeof content !== 'string') return normal('Nội dung trống');

    // Bỏ qua nếu nội dung CHÍNH LÀ nhãn ngày tháng của Zalo (hôm qua, 15/07...)
    if (isZaloDateLabel(content)) return normal('Nhãn ngày tháng của Zalo (Đã bỏ qua)');

    // FIX: So khớp theo nguyên từ (xem containsPhrase) thay vì chuỗi con đã bỏ dấu
    const matchedVip = (config.vipSenders || []).find(vip => containsPhrase(sender, vip)) || null;
    const matchedKeyword = (config.urgentKeywords || []).find(kw => containsPhrase(content, kw)) || null;

    const timeTag = isNight ? '🌙 [BAN ĐÊM / NGOÀI GIỜ]' : '☀️ [BAN NGÀY]';
    let reason;
    if (matchedVip && matchedKeyword) {
        reason = `${timeTag} Người gửi VIP [${sender}] nhắn từ khóa khẩn cấp [${matchedKeyword}]`;
    } else if (matchedVip) {
        reason = `${timeTag} Tin nhắn trực tiếp từ Người gửi VIP [${sender}]`;
    } else if (matchedKeyword) {
        reason = isNight && isGroup
            ? `🌙 [BAN ĐÊM] Nhóm chat [${groupName || sender}] có từ khóa khẩn cấp [${matchedKeyword}]`
            : `${timeTag} Phát hiện từ khóa khẩn cấp [${matchedKeyword}] từ [${sender}${isGroup ? ` @ ${groupName}` : ''}]`;
    } else {
        return normal('Tin nhắn thông thường');
    }

    return { isUrgent: true, reason, matchedVip, matchedKeyword, isNight };
}

function cooldownKeyOf(message) {
    const { sender = '', isGroup = false, groupName = '' } = message;
    const key = isGroup ? `group:${groupName || sender}` : `sender:${sender}`;
    // Tin thử từ giao diện dùng cooldown riêng → không chặn cảnh báo thật của cùng người gửi
    return message.isTest ? `test:${key}` : key;
}

/**
 * Cơ chế Cooldown: chống báo động liên tiếp từ cùng 1 người / nhóm
 */
export function checkCooldown(message, config = loadConfig()) {
    const key = cooldownKeyOf(message);
    // FIX: cooldownMinutes = 0 nghĩa là không giãn cách (trước đây `|| 3` biến 0 thành 3 phút)
    const cooldownMs = (config.cooldownMinutes ?? 3) * 60 * 1000;
    const elapsed = Date.now() - (cooldownMap.get(key) || 0);
    if (elapsed < cooldownMs) {
        return { coolingDown: true, remainingSeconds: Math.round((cooldownMs - elapsed) / 1000), key };
    }
    return { coolingDown: false, remainingSeconds: 0, key };
}

export function markCooldown(key) {
    cooldownMap.set(key, Date.now());
    if (cooldownMap.size > 500) {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const [k, t] of cooldownMap) if (t < cutoff) cooldownMap.delete(k);
    }
}

/**
 * Khung giờ được phép báo động (Cài đặt → Lịch cảnh báo). Hỗ trợ khung qua đêm, VD 22:00-06:00
 */
export function isWithinAlertSchedule(config = loadConfig(), date = new Date()) {
    const schedule = config.timeSettings?.alertSchedule;
    if (!schedule?.enabled) return true;
    const m = String(schedule.activeHours || '').match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
    if (!m) return true;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    const now = date.getHours() * 60 + date.getMinutes();
    return start <= end ? now >= start && now <= end : now >= start || now <= end;
}

/**
 * Đánh giá nhanh theo bộ lọc từ khóa + cooldown (giữ lại cho test/filter.test.js)
 * @returns {Object} { shouldCall, isUrgent, reason, isCoolingDown, isNight }
 */
export function evaluateMessage(message) {
    const config = loadConfig();
    const result = classifyMessage(message, config);
    if (!result.isUrgent) {
        return { shouldCall: false, isUrgent: false, reason: result.reason, isNight: result.isNight };
    }

    const cooldown = checkCooldown(message, config);
    if (cooldown.coolingDown) {
        return {
            shouldCall: false,
            isUrgent: true,
            reason: `${result.reason} (Đang giãn cách Cooldown, còn ${cooldown.remainingSeconds}s)`,
            isCoolingDown: true,
            isNight: result.isNight
        };
    }

    markCooldown(cooldown.key);
    return { shouldCall: true, isUrgent: true, reason: result.reason, isCoolingDown: false, isNight: result.isNight };
}
