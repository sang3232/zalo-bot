import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { ocrImage } from './ocr.js';
import { logger } from './logger.js';

/**
 * "Mở" file để đọc = TRÍCH CHỮ BẰNG CODE. Không bao giờ mở bằng Word/Excel/ứng dụng mặc định,
 * không chạy macro, không giải nén file nén: file từ Zalo có thể do người lạ gửi.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_HELPER = path.resolve(__dirname, '../tools/doc_text.py');

const TEXT_EXT = new Set(['txt', 'csv', 'tsv', 'md', 'json', 'log']);
const OFFICE_EXT = new Set(['pdf', 'docx', 'xlsx', 'pptx']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp']);
const MAX_SCAN_IMAGES = 10;
export const MAX_TEXT_CHARS = 200000;

export function docDuocKhong(ten) {
    const ext = path.extname(ten).slice(1).toLowerCase();
    return TEXT_EXT.has(ext) || OFFICE_EXT.has(ext) || IMAGE_EXT.has(ext);
}

/**
 * @returns {Promise<{ ok: boolean, loai?: string, text?: string, soTrang?: number, ghiChu?: string }>}
 */
export async function docFile(filePath, { maxMB = 20, ocrLang = 'en' } = {}) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (!docDuocKhong(filePath)) return { ok: false, ghiChu: `không đọc loại file .${ext}` };

    const size = fs.statSync(filePath).size;
    if (size > maxMB * 1024 * 1024) {
        return { ok: false, ghiChu: `file ${(size / 1048576).toFixed(1)} MB, quá giới hạn ${maxMB} MB` };
    }

    if (TEXT_EXT.has(ext)) {
        const text = fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, '');
        return { ok: true, loai: ext, text: text.slice(0, MAX_TEXT_CHARS) };
    }

    if (IMAGE_EXT.has(ext)) {
        const r = await ocrImage(filePath, ocrLang);
        return { ok: true, loai: 'anh', text: r.text, ghiChu: `OCR ${r.lines} dòng` };
    }

    const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zalobot-anh-'));
    try {
        const r = await chayPython(filePath, imgDir);
        let text = r.text || '';
        // PDF quét: trang không có lớp chữ → gửi ảnh nhúng sang OCR
        for (const img of (r.images || []).slice(0, MAX_SCAN_IMAGES)) {
            try {
                const o = await ocrImage(img, ocrLang);
                text += `\n\n[OCR ${path.basename(img, '.png')}]\n${o.text}`;
            } catch (e) {
                logger.warn(`[Đọc file] OCR ảnh trong PDF lỗi: ${e.message}`);
            }
        }
        const ghiChu = [r.note, r.images?.length ? `OCR ${r.images.length} ảnh quét` : ''].filter(Boolean).join(', ');
        return { ok: true, loai: ext, text: text.slice(0, MAX_TEXT_CHARS), soTrang: r.pages ?? undefined, ghiChu };
    } finally {
        fs.rmSync(imgDir, { recursive: true, force: true });
    }
}

function chayPython(file, imgDir) {
    return new Promise((resolve, reject) => {
        execFile(process.env.PYTHON || 'python', [PY_HELPER, file, imgDir], {
            timeout: 120000,
            maxBuffer: 64 * 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`doc_text.py lỗi: ${String(stderr || err.message).slice(0, 300)}`));
            let j;
            try {
                j = JSON.parse(String(stdout).trim().split('\n').pop());
            } catch (e) {
                return reject(new Error('doc_text.py trả dữ liệu hỏng'));
            }
            if (!j.ok) return reject(new Error(j.error || 'doc_text.py báo lỗi'));
            resolve(j);
        });
    });
}
