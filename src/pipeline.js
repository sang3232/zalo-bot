import crypto from 'crypto';
import { loadConfig, classifyMessage, checkCooldown, markCooldown, isWithinAlertSchedule } from './filter.js';
import { analyzeMessage, getApiKey } from './ai.js';
import { raiseAlert } from './alerter.js';
import { createTask } from './tasks.js';
import { addMessage, annotateMessage } from './history.js';
import { ghiNhanTin } from './autoplan.js';
import { logger } from './logger.js';

function nowAsDue() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Lịch tự động (file / ảnh / đoạn hội thoại có hẹn → GLM → công việc). Chạy nền, lỗi không làm hỏng luồng báo động.
function lichTuDong(msg) {
    try {
        ghiNhanTin(msg);
    } catch (e) {
        logger.error('[Lịch] Lỗi ghi nhận tin nhắn', e.message);
    }
}

function safeCreateTask(input, source) {
    try {
        return createTask(input, source);
    } catch (e) {
        logger.warn(`[Công việc] Không tạo được công việc: ${e.message}`);
        return null;
    }
}

/**
 * Xử lý một tin nhắn mới: lưu lịch sử → bộ lọc từ khóa/VIP → AI (nếu bật) → tạo công việc → báo động
 * @param {{ sender: string, content: string, isGroup?: boolean, groupName?: string, isSelf?: boolean, isTest?: boolean }} msg
 */
export async function handleMessage(msg) {
    const config = loadConfig();
    const record = addMessage(msg);
    logger.message(`${msg.isTest ? '[THỬ] ' : ''}${msg.sender}`, msg.content, msg.isGroup, msg.groupName);

    const decision = { urgent: false, reason: '', source: 'rule', task: null, alerted: false, coolingDown: false, outsideSchedule: false };

    if (msg.isSelf && config.ignoreOwnMessages) {
        // Tin của mình không báo động, nhưng vẫn lên lịch được ("mai 9h khám răng" gửi vào My Documents)
        lichTuDong(msg);
        decision.reason = 'Tin do chính bạn gửi (đã bỏ qua)';
        annotateMessage(record.id, decision);
        return decision;
    }

    const rule = classifyMessage(msg, config);
    decision.urgent = rule.isUrgent;
    decision.reason = rule.reason;

    // Phạm vi AI: "all" = mọi tin mới, "keywords" = chỉ tin đã trùng từ khóa / VIP
    const wantsAi = config.ai?.enabled && getApiKey() && (config.ai.scope === 'all' || rule.isUrgent);
    const ai = wantsAi ? await analyzeMessage(msg, config) : null;
    // Sau AI: việc AI tạo từ tin lẻ có trước, lịch tự động (ghép cả đoạn hội thoại) bỏ việc trùng với nó
    lichTuDong(msg);

    // VIP luôn được báo động; còn lại AI quyết định (giảm báo nhầm kiểu "Alo các bạn ơi")
    if (ai && !rule.matchedVip) {
        decision.urgent = ai.urgent;
        decision.reason = `🤖 ${ai.reason || (ai.urgent ? 'AI đánh giá là khẩn cấp' : 'AI đánh giá là tin bình thường')}`;
        decision.source = 'ai';
    }

    const source = {
        sender: String(msg.sender ?? '').slice(0, 200),
        content: String(msg.content ?? '').slice(0, 500),
        dedupeKey: crypto.createHash('md5').update(`${msg.sender}:::${msg.content}`).digest('hex'),
        isTest: !!msg.isTest
    };

    if (ai?.task) decision.task = safeCreateTask(ai.task, { type: 'zalo', ...source });

    if (decision.urgent) {
        if (!isWithinAlertSchedule(config)) {
            decision.outsideSchedule = true;
            logger.info(`🌙 [Ngoài khung giờ cảnh báo] ${decision.reason}`);
        } else {
            const cooldown = checkCooldown(msg, config);
            if (cooldown.coolingDown) {
                decision.coolingDown = true;
                logger.info(`⏳ [Cooldown] ${decision.reason} (còn ${cooldown.remainingSeconds}s)`);
            } else {
                markCooldown(cooldown.key);
                raiseAlert({ sender: msg.sender, content: msg.content, reason: decision.reason, source: decision.source, isTest: !!msg.isTest });
                decision.alerted = true;

                if (config.autoTaskFromAlerts && !decision.task) {
                    decision.task = safeCreateTask({
                        title: `Xử lý tin khẩn từ ${msg.sender}`.slice(0, 200),
                        note: String(msg.content ?? '').slice(0, 2000),
                        due: nowAsDue(),
                        priority: 'high'
                    }, { type: 'alert', ...source });
                }
            }
        }
    }

    annotateMessage(record.id, decision);
    return decision;
}
