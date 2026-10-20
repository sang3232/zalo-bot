import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const HOP_THU = 'yuyuko_hop_thu.jsonl';
let daCanhBao = false;

/**
 * Gửi một dòng sang Yuyuko qua hộp thư yuyuko_hop_thu.jsonl cạnh shimeji.exe (YUYUKO_DIR).
 * CHỈ NỐI THÊM dòng — Yuyuko tự nhớ đã đọc tới đâu (yuyuko_hop_thu.vitri). Không ghi thẳng vào
 * tasks_schedule.json vì Yuyuko ghi đè cả file đó mỗi lần lưu.
 *   loai "nhac"      → Yuyuko kêu + hiện bong bóng { noi_dung }
 *   loai "thong_bao" → bong bóng ngắn { noi_dung }
 *   loai "lich_moi"  → thêm task một lần vào lịch Yuyuko { tieu_de, ghi_chu, ngay, gio, phut }
 */
export function guiYuyuko(loai, duLieu = {}) {
    // YUYUKO_HOP_THU_DIR: đặt hộp thư chỗ khác (chạy thử không làm phiền Yuyuko thật)
    const dir = process.env.YUYUKO_HOP_THU_DIR || process.env.YUYUKO_DIR;
    if (!dir || !fs.existsSync(dir)) {
        if (!daCanhBao) {
            logger.warn('[Yuyuko] Chưa đặt YUYUKO_DIR (thư mục chứa shimeji.exe) hoặc thư mục không có — bỏ qua nhắc qua Yuyuko');
            daCanhBao = true;
        }
        return false;
    }
    try {
        const dong = JSON.stringify({ t: Math.floor(Date.now() / 1000), loai, ...duLieu });
        fs.appendFileSync(path.join(dir, HOP_THU), dong + '\n', 'utf-8');
        return true;
    } catch (e) {
        logger.error('[Yuyuko] Không ghi được hộp thư', e.message);
        return false;
    }
}
