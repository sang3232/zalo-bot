import fs from 'fs';
import path from 'path';

const DEFAULT_URL = 'http://127.0.0.1:5000/ocr';   // đặt OCR_SERVER_URL trong .env
const TIMEOUT_MS = 60000;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp' };

/**
 * Gửi ảnh sang máy chủ OCR của Yuyuko (Trạm 1 — Flask :5000, cùng cổng dây chuyền làm truyện).
 * Đo 30/09 trên ảnh chữ tiếng Việt có dấu:
 *   lang="en" → mất dấu nhưng sạch: "Thoi gian: 8h30 sang Thu Bay, ngay 11/10/2026" (0,3 s)
 *   lang="vi" → dấu nửa vời, rơi chữ: "Thur Bäy", "Phng" (4 s)
 * Ngày/giờ thì cả hai đều giữ nguyên, nên mặc định dùng "en".
 */
export async function ocrImage(filePath, lang = 'en') {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const form = new FormData();
    form.append('image', new Blob([fs.readFileSync(filePath)], { type: MIME[ext] || 'application/octet-stream' }), path.basename(filePath));
    form.append('lang', lang);

    let res;
    try {
        res = await fetch(process.env.OCR_SERVER_URL || DEFAULT_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
        throw new Error(e.name === 'TimeoutError' ? `Máy chủ OCR không phản hồi sau ${TIMEOUT_MS / 1000} giây` : `Không kết nối được máy chủ OCR: ${e.message}`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Máy chủ OCR báo HTTP ${res.status}${data?.error ? `: ${data.error}` : ''}`);
    if (data?.error) throw new Error(`OCR báo lỗi: ${data.error}`);
    return { text: String(data?.text || ''), lines: data?.line_count || 0 };
}
