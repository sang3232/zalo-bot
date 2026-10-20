import { listTasks } from './tasks.js';
import { readJson, writeJson } from './store.js';
import { loadConfig } from './config.js';
import { bus } from './bus.js';
import { guiYuyuko } from './yuyuko.js';
import { docDue, moTaDue, parseGio } from './lich.js';
import { logger } from './logger.js';

/**
 * Nhắc giờ cho MỌI công việc chưa xong có hạn chót (tạo tay, AI trích từ tin, lịch từ file/ảnh):
 *   - Có giờ: trước 1 ngày, trước 1 tiếng, đúng giờ (reminders.beforeMinutes)
 *   - Cả ngày: tối hôm trước 20:00 và sáng hôm đó 07:00
 * Nhắc qua giao diện (sự kiện 'notice') và Yuyuko (hộp thư yuyuko_hop_thu.jsonl).
 * Mốc đã nhắc lưu ở data/reminders-sent.json → khởi động lại bot không nhắc lại.
 * Bỏ qua việc tự tạo từ cảnh báo (hạn = lúc báo động, đã kêu còi rồi).
 */

const SENT_FILE = 'reminders-sent.json';
const TICK_MS = 30 * 1000;
const LATE_LIMIT_MS = 6 * 3600 * 1000;      // bot tắt lâu hơn thế thì bỏ mốc nhắc cũ, chỉ ghi log
const KEEP_SENT_MS = 45 * 86400 * 1000;
const GRACE_MS = 60 * 1000;

export function nhanNhac(phut) {
    if (phut === 0) return 'đến giờ';
    if (phut % 1440 === 0) return `còn ${phut / 1440} ngày`;
    if (phut % 60 === 0) return `còn ${phut / 60} tiếng`;
    return `còn ${phut} phút`;
}

/**
 * Các mốc nhắc của một công việc (kể cả mốc đã qua — người gọi tự lọc).
 * @returns {{ khoa: string, luc: number, nhan: string }[]}
 */
export function tinhMocNhac(task, cfg = {}) {
    const d = docDue(task?.due);
    if (!d) return [];
    const moc = [];
    const them = (luc, nhan) => moc.push({ khoa: `${task.id}|${task.due}|${nhan}`, luc, nhan });
    if (d.coGio) {
        const truoc = [...new Set(cfg.beforeMinutes || [1440, 60, 0])].filter(p => Number.isInteger(p) && p >= 0).sort((a, b) => b - a);
        for (const p of truoc) them(d.date.getTime() - p * 60000, nhanNhac(p));
    } else {
        const t = d.date;
        const toi = parseGio(cfg.allDayEveningBefore) || { h: 20, p: 0 };
        const sang = parseGio(cfg.allDayAt) || { h: 7, p: 0 };
        them(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1, toi.h, toi.p).getTime(), 'ngày mai');
        them(new Date(t.getFullYear(), t.getMonth(), t.getDate(), sang.h, sang.p).getTime(), 'hôm nay');
    }
    return moc;
}

/**
 * Mốc nhắc đã đến giờ mà chưa nhắc.
 * Không nhắc mốc nằm TRƯỚC lúc việc được tạo / sửa lần cuối (VD: việc tạo lúc 8h cho cuộc họp 9h
 * thì không nhắc "còn 1 ngày" nữa).
 * @param {Map<string, number>} daNhac khoá → lúc nhắc
 * @returns {{ canNhac: { task, nhac, treMs }[], boLo: { task, nhac, treMs }[] }}
 */
export function layNhacDenHan(tasks, daNhac, now = new Date(), cfg = {}) {
    const canNhac = [];
    const boLo = [];
    const nowMs = now.getTime();
    for (const task of tasks) {
        if (!task || task.status === 'done' || task.source?.type === 'alert') continue;
        const tu = Date.parse(task.updatedAt || task.createdAt || '') || 0;
        for (const nhac of tinhMocNhac(task, cfg)) {
            if (nhac.luc > nowMs || daNhac.has(nhac.khoa) || nhac.luc < tu - GRACE_MS) continue;
            const treMs = nowMs - nhac.luc;
            (treMs > LATE_LIMIT_MS ? boLo : canNhac).push({ task, nhac, treMs });
        }
    }
    return { canNhac, boLo };
}

export function loiNhac(task, nhan) {
    const khi = moTaDue(task.due);
    if (nhan === 'đến giờ') return `Chủ nhân ơi, đến giờ rồi: ${task.title} (${khi})!`;
    if (nhan === 'hôm nay') return `Chủ nhân ơi, hôm nay có: ${task.title}!`;
    if (nhan === 'ngày mai') return `Chủ nhân ơi, ngày mai có: ${task.title}!`;
    return `Chủ nhân ơi, ${nhan} nữa là: ${task.title} (${khi})!`;
}

function guiNhac({ task, nhac, treMs }, cfg) {
    const tre = treMs > 5 * 60000 ? ` (nhắc trễ ${Math.round(treMs / 60000)} phút vì bot tắt)` : '';
    bus.emit('notice', {
        kind: 'reminder',
        title: `⏰ Nhắc lịch — ${nhac.nhan}${tre}`,
        body: `${task.title} · ${moTaDue(task.due)}`,
        taskId: task.id,
        at: Date.now()
    });
    if (cfg.yuyuko !== false) guiYuyuko('nhac', { noi_dung: loiNhac(task, nhac.nhan) });
    logger.info(`[Nhắc] ⏰ "${task.title}" (${nhac.nhan})${tre}`);
}

let dongHo = null;

/** Chạy đồng hồ nhắc (mỗi 30 giây). Gọi nhiều lần vẫn chỉ có một đồng hồ. */
export function batDauNhacLich() {
    if (dongHo) return;
    const raw = readJson(SENT_FILE, {});
    const daNhac = new Map(Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(([, v]) => typeof v === 'number'));

    const tick = () => {
        const cfg = loadConfig().reminders || {};
        if (cfg.enabled === false) return;
        try {
            const now = Date.now();
            const { canNhac, boLo } = layNhacDenHan(listTasks(), daNhac, new Date(now), cfg);
            for (const b of boLo) {
                daNhac.set(b.nhac.khoa, now);
                logger.warn(`[Nhắc] Bỏ lỡ nhắc "${b.task.title}" (${b.nhac.nhan}) — bot tắt ${Math.round(b.treMs / 3600000)} tiếng`);
            }
            for (const n of canNhac) {
                daNhac.set(n.nhac.khoa, now);
                try { guiNhac(n, cfg); } catch (e) { logger.error(`[Nhắc] Lỗi khi nhắc "${n.task.title}"`, e.message); }
            }
            if (canNhac.length || boLo.length) {
                for (const [k, t] of daNhac) if (now - t > KEEP_SENT_MS) daNhac.delete(k);
                writeJson(SENT_FILE, Object.fromEntries(daNhac));
            }
        } catch (e) {
            logger.error('[Nhắc] Lỗi đồng hồ nhắc', e.message);
        }
    };
    tick();
    dongHo = setInterval(tick, TICK_MS);
    dongHo.unref?.();
}
