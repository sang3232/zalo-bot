import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { DATA_DIR } from './store.js';
import { createTask, listTasks, updateTask } from './tasks.js';
import { bus } from './bus.js';
import { timTheFile, theTuDom } from './filecard.js';
import { timMocThoiGian, nenGuiGLM } from './dates.js';
import { docFile, docDuocKhong } from './docs.js';
import { danhGiaFile, trichLich } from './planner.js';
import { chuanHoa, khoaTrung, giongViec, moTaDue, docDue } from './lich.js';
import { guiYuyuko } from './yuyuko.js';

/**
 * Lịch tự động từ Zalo (GLM qua OpenRouter, mặc định z-ai/glm-5.3-flash):
 *  1. Tin nhắn có thẻ file → chờ gom thêm tin phía sau (mặc định 90 giây).
 *  2. Có file trong tay (bot tự bấm "Lưu về máy" / Chủ nhân bấm tải trong trình duyệt của bot / thả vào
 *     data/hop_file) → trích chữ bằng code; ảnh đi qua OCR Trạm 1 của Yuyuko.
 *  3. File có ngày rõ ràng → GLM đọc cả file. Không có → GLM xem tên file + người gửi + nhóm +
 *     tin trước/sau (+ đoạn đầu file) để quyết có đọc cả file không.
 *  4. Việc tìm được → công việc (tasks.js, hiện trên lịch của giao diện) → reminders.js nhắc đúng giờ
 *     qua giao diện + Yuyuko.
 * Ảnh trong khung chat đang mở: lấy ảnh từ trang → OCR → có ngày giờ thì đi bước 3–4 như file.
 * OCR Trạm 1 không với tới → gửi ảnh thẳng cho GLM (autoSchedule.visionFallback). Ảnh trong khung chat
 * chỉ được gửi khi tin nhắn quanh ảnh có dấu hiệu lịch, để không đẩy mọi ảnh trong nhóm lên mạng.
 * Tin nhắn chữ: theo dõi theo ĐOẠN HỘI THOẠI. Một đoạn chat có manh mối (ngày / giờ / hạn, hoặc "ok, chốt"
 * ngay sau manh mối) → chờ hội thoại ngớt (60 giây) → gửi GLM cả đoạn gần đây (kèm giờ gửi thật) để ghép
 * manh mối rải rác thành việc đã chốt. AI phân tích tin (ai.js) chỉ thấy từng tin lẻ; việc trùng với việc
 * nó đã tạo (cùng đoạn chat + cùng giờ, hoặc tên gần giống) bị bỏ.
 * Hội thoại đổi giờ / ngày / địa điểm hoặc huỷ một việc bot đã ghi từ đoạn chat đó → GLM trả cap_nhat →
 * bot sửa hạn chót (ghi "Đổi lịch: cũ → mới") hoặc đánh dấu "❌ Huỷ" (không xoá). Việc tạo tay không bị đụng.
 */

const FILES_DIR = path.join(DATA_DIR, 'files');
export const DROP_DIR = path.join(DATA_DIR, 'hop_file');   // thả file vào đây là bot tự đọc
const JOB_TICK_MS = 5000;
const DROP_TICK_MS = 10000;
const CHO_FILE_MS = 24 * 3600 * 1000;
const TRUNG_FILE_MS = 30 * 60 * 1000;
const TIN_GAN_DAY_MAX = 40;
// "ok", "chốt", "được"... ngay sau manh mối → hẹn vừa được chốt, xét lại đoạn hội thoại
const CHOT_RE = /(?<![\p{L}\p{N}])(?:ok|oke|okie|okela|ô kê|chốt|chot|được|duoc|đc|dc|nhất trí|nhat tri|đồng ý|dong y|thống nhất|thong nhat|vậy nhé|vay nhe|hẹn|hen)(?![\p{L}\p{N}])/iu;
const pad = n => String(n).padStart(2, '0');

export function cauHinhLich() {
    return loadConfig().autoSchedule;
}

const tinGanDay = new Map();   // đoạn chat → [{ sender, content, at }]
const viecCho = [];            // file / ảnh vừa thấy, đang gom tin nhắn phía sau
const choFile = [];            // GLM bảo nên đọc mà bot chưa có file → chờ file trong 24 giờ
const daThayFile = new Map();  // khoá tên file → lúc thấy (khung chat và thanh bên cùng báo một file)
const fileDaTai = new Map();   // khoá tên file → đường dẫn đã lưu
const dangXuLyTay = new Set();
const luotGoiTin = [];         // mốc các lượt GLM cho tin chữ (giới hạn mỗi giờ)
const luotAnh = [];            // mốc các lượt lấy ảnh để OCR (giới hạn mỗi giờ)
const daThayAnh = new Set();   // msgId của tin ảnh đã lấy
// "huỷ / hoãn / dời / đổi / thôi / bận..." — chỉ đáng xét khi đoạn chat đang có việc bot đã ghi
const HUY_DOI_RE = /(?<![\p{L}\p{N}])(?:huỷ|hủy|huy keo|huy hen|hoãn|dời|đổi|thôi|bận|cancel|lùi|chuyển sang|chuyển qua)(?![\p{L}\p{N}])/iu;
const hoiThoaiCho = new Map(); // đoạn chat → { batDau, hanYen, hanCuoi, coMoi, nguoi, laNhom } đang chờ hội thoại ngớt
const manhMoiGanNhat = new Map(); // đoạn chat → lúc có manh mối thời gian gần nhất
let trang = null;
let daKhoiDong = false;

const chatCua = t => t.source?.chat || t.source?.group || t.source?.sender || '';   // việc AI phân tích tin: sender = tên đoạn chat
const diaDiemCua = t => (String(t.note || '').match(/^📍 (.*)$/m) || [])[1] || '';
const safeName = s => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150);
const khoaTen = s => safeName(s).toLowerCase().replace(/\s*\(\d+\)(?=\.[^.]+$)/, '');   // "a (1).pdf" → "a.pdf"
const homNay = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// Thẻ tin nhắn Zalo hay dính giờ gửi ở dòng cuối ("…\n18:42")
const boGioCuoi = s => String(s || '').replace(/(\s*\n\s*\d{1,2}:\d{2})+\s*$/, '').trim();

function moTaNguon(n) {
    const phan = [];
    if (n.loai === 'hoi_thoai') return `đoạn chat "${n.doan_chat}"`;
    if (n.loai === 'anh') phan.push('ảnh');
    else if (n.file) phan.push(`file "${n.file}"`);
    if (n.nguoi_gui) phan.push(`từ ${n.nguoi_gui}`);
    if (n.nhom && n.nhom !== n.nguoi_gui) phan.push(`(${n.nhom})`);
    return phan.join(' ') || 'từ Zalo';
}

// Thông báo lên giao diện quản lý (toast + thông báo trình duyệt)
function thongBao(kind, title, body = '') {
    bus.emit('notice', { kind, title, body, at: Date.now() });
}

function timFileDaCo(ten) {
    const duong = fileDaTai.get(khoaTen(ten));
    return duong && fs.existsSync(duong) ? duong : null;
}

function giuChoFile(job) {
    if (choFile.some(j => khoaTen(j.file.ten) === khoaTen(job.file.ten))) return;
    choFile.push({ ...job, luc: Date.now() });
}

/**
 * Gắn trang Zalo Web: mọi file tải về trong trình duyệt của bot (bot tự bấm, hoặc Chủ nhân bấm
 * tay) đều được lưu vào data/files và ghép với thẻ file đang chờ. Gọi lại sau mỗi lần kết nối lại.
 */
export function ganTrang(page) {
    trang = page;
    page.on('download', async (dl) => {
        try {
            const ten = dl.suggestedFilename();
            const thuMuc = path.join(FILES_DIR, homNay());
            fs.mkdirSync(thuMuc, { recursive: true });
            const duong = path.join(thuMuc, `${Date.now()}_${safeName(ten)}`);
            await dl.saveAs(duong);
            fileDaTai.set(khoaTen(ten), duong);
            logger.info(`[Lịch] Đã tải file "${ten}" → ${duong}`);

            const i = choFile.findIndex(j => khoaTen(j.file.ten) === khoaTen(ten));
            if (i >= 0) {
                const job = choFile.splice(i, 1)[0];
                job.duong = duong;
                xuLyFile(job, cauHinhLich()).catch(e => logger.error(`[Lịch] Lỗi xử lý file "${ten}"`, e.message));
            }
        } catch (e) {
            logger.warn(`[Lịch] Không lưu được file tải về: ${e.message}`);
        }
    });
}

/**
 * Bấm "Lưu về máy" của thẻ file trong khung chat đang mở (DOM soi trên Zalo Web thật 01/10):
 *   .file-message__container
 *     .file-message__content-title[title = tên đầy đủ]
 *     .file-message__content-actions.none > a.file-message__actions.download[title="Lưu về máy"]
 * Nút chỉ hiện khi rê chuột vào thẻ → rê chuột rồi bấm; không được thì bấm bằng JS.
 * Không bấm được thì Chủ nhân tải tay trong trình duyệt của bot hoặc thả file vào data/hop_file.
 */
async function taiTuDong(the) {
    if (!trang || trang.isClosed()) return false;
    let daBam = false;
    try {
        const thay = await trang.evaluate((ten) => {
            const chuan = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
            document.querySelectorAll('[data-zalobot-tai]').forEach(e => e.removeAttribute('data-zalobot-tai'));
            const the = [...document.querySelectorAll('.file-message__container')].reverse().find(c => {   // thẻ mới nhất nằm cuối
                const t = c.querySelector('.file-message__content-title');
                return t && (chuan(t.getAttribute('title')) === chuan(ten) || chuan(t.textContent) === chuan(ten));
            });
            if (!the) return false;
            the.setAttribute('data-zalobot-tai', '1');
            return true;
        }, the.ten);
        if (thay) {
            const khung = trang.locator('[data-zalobot-tai="1"]');
            const nut = khung.locator('a.file-message__actions.download, [data-translate-title="STR_DOWNLOAD_FILE"]').first();
            try {
                await khung.hover({ timeout: 3000 });
                await nut.click({ timeout: 3000 });
            } catch (e) {
                await nut.evaluate(el => el.click(), undefined, { timeout: 3000 });   // nút còn ẩn / lớp phủ chặn chuột
            }
            daBam = true;
        }
    } catch (e) {
        logger.warn(`[Lịch] Lỗi khi thử bấm tải "${the.ten}": ${e.message}`);
    }
    if (!daBam) {
        logger.info(`[Lịch] Chưa tự bấm tải được "${the.ten}" (đoạn chat không mở trong trình duyệt của bot?) — tải tay trong trình duyệt của bot hoặc thả vào ${DROP_DIR}`);
        return false;
    }
    for (let i = 0; i < 40; i++) {
        if (timFileDaCo(the.ten)) return true;
        await new Promise(r => setTimeout(r, 500));
    }
    logger.warn(`[Lịch] Đã bấm tải "${the.ten}" nhưng 20 giây chưa thấy file về`);
    return false;
}

/**
 * Lấy ảnh của một tin trong khung chat (ảnh Zalo hiển thị bằng blob: URL — chỉ đọc được từ trong trang).
 * @returns {Promise<Array<{ b64: string, mime: string }>>}
 */
async function layAnhTrongTin(msgId, toiDa = 4) {
    if (!trang || trang.isClosed() || !msgId) return [];
    return trang.evaluate(async ({ msgId, toiDa }) => {
        const khung = document.getElementById(msgId);
        if (!khung) return [];
        const ra = [];
        for (const img of [...khung.querySelectorAll('img.zimg-el')].slice(0, toiDa)) {
            try {
                if (!img.src) continue;
                const blob = await (await fetch(img.src)).blob();
                if (!blob.type.startsWith('image/') || blob.size < 2000 || blob.size > 15 * 1048576) continue;
                const b64 = await new Promise((ok, loi) => {
                    const r = new FileReader();
                    r.onload = () => ok(String(r.result).split(',')[1] || '');
                    r.onerror = () => loi(r.error);
                    r.readAsDataURL(blob);
                });
                if (b64) ra.push({ b64, mime: blob.type });
            } catch (e) { /* ảnh chưa tải xong / bị chặn — bỏ qua */ }
        }
        return ra;
    }, { msgId, toiDa });
}

const DUOI_ANH = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/bmp': 'bmp' };
const MIME_ANH = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp' };
const NGU_CANH_ANH_MS = 30 * 60 * 1000;

// Tin nhắn quanh ảnh (30 phút) có nhắc ngày giờ / họp / thi / lịch... không
function coDauHieuLich(job) {
    const tu = Date.now() - NGU_CANH_ANH_MS;
    const chu = [...job.truoc, ...job.sau].filter(t => !t.at || t.at >= tu).map(t => t.content).join('\n');
    const k = timMocThoiGian(chu);
    return k.ngayRo || k.ngayMo || k.gio || k.han || k.tuLich;
}

// Ảnh trong tin → OCR Trạm 1 → có ngày giờ thì xếp vào hàng chờ như một file (gom tin phía sau rồi hỏi GLM)
async function xuLyAnh(msg, khoa, truoc, cfg) {
    if (!msg.msgId || daThayAnh.has(msg.msgId)) return;
    daThayAnh.add(msg.msgId);
    if (daThayAnh.size > 500) daThayAnh.delete(daThayAnh.values().next().value);
    const now = Date.now();
    while (luotAnh.length && now - luotAnh[0] > 3600000) luotAnh.shift();
    if (luotAnh.length >= cfg.maxImagesPerHour) {
        logger.warn(`[Lịch] Đã OCR ${luotAnh.length} lượt ảnh trong 1 giờ — tạm bỏ qua ảnh từ ${msg.nguoiGui || msg.sender}`);
        return;
    }
    luotAnh.push(now);

    await new Promise(r => setTimeout(r, 2500));                      // chờ ảnh thật thay ảnh mờ xem trước
    const anh = await layAnhTrongTin(msg.msgId);
    if (!anh.length) {
        logger.info(`[Lịch] Không lấy được ảnh trong tin của ${msg.nguoiGui || msg.sender}`);
        return;
    }
    const thuMuc = path.join(FILES_DIR, homNay());
    fs.mkdirSync(thuMuc, { recursive: true });
    const chu = [];
    let loiOcr = 0;
    for (const [i, a] of anh.entries()) {
        const duong = path.join(thuMuc, `${Date.now()}_anh_${safeName(msg.msgId)}_${i + 1}.${DUOI_ANH[a.mime] || 'png'}`);
        fs.writeFileSync(duong, Buffer.from(a.b64, 'base64'));
        try {
            const doc = await docFile(duong, { maxMB: cfg.maxFileMB, ocrLang: cfg.ocrLang });
            if (doc.ok && doc.text.trim()) chu.push(doc.text.trim());
        } catch (e) {
            loiOcr++;
            logger.warn(`[Lịch] OCR ảnh lỗi: ${e.message}`);
        }
    }
    const vanBan = chu.join('\n\n');
    const tenAnh = anh.length > 1 ? `${anh.length} ảnh` : 'ảnh';
    if (!vanBan && loiOcr && cfg.visionFallback) {
        // Chưa biết ảnh có lịch không → gom tin phía sau, lúc xử lý xét dấu hiệu lịch rồi mới gửi ảnh cho GLM
        viecCho.push({
            khoa, nguoiGui: msg.nguoiGui || msg.sender, nhom: msg.groupName || '', laNhom: !!msg.isGroup,
            file: { ten: `${tenAnh} (GLM đọc ảnh)`, duoi: 'png', dungLuong: '', soByte: 0, dongTruoc: [] },
            laAnh: true, anh, truoc, sau: [], hanChay: Date.now() + cfg.contextWaitSeconds * 1000
        });
        logger.info(`[Lịch] OCR không chạy — giữ ${tenAnh} từ ${msg.nguoiGui || msg.sender}, gom tin phía sau ${cfg.contextWaitSeconds}s rồi xét có gửi cho GLM không`);
        return;
    }
    if (!vanBan || !nenGuiGLM(timMocThoiGian(vanBan), true)) {
        logger.info(`[Lịch] Ảnh từ ${msg.nguoiGui || msg.sender}: ${vanBan ? `${vanBan.length} ký tự, không thấy ngày giờ` : 'không có chữ'} — bỏ qua`);
        return;
    }
    viecCho.push({
        khoa, nguoiGui: msg.nguoiGui || msg.sender, nhom: msg.groupName || '', laNhom: !!msg.isGroup,
        file: { ten: `${tenAnh} (chữ đọc bằng OCR)`, duoi: 'png', dungLuong: '', soByte: 0, dongTruoc: [] },
        laAnh: true, vanBan, truoc, sau: [], hanChay: Date.now() + cfg.contextWaitSeconds * 1000
    });
    logger.info(`[Lịch] Ảnh từ ${msg.nguoiGui || msg.sender} có mốc thời gian (OCR ${vanBan.length} ký tự) — gom tin nhắn phía sau ${cfg.contextWaitSeconds}s rồi hỏi GLM`);
}

/**
 * Gọi cho MỌI tin nhắn mới (từ pipeline.js). Không chặn: việc nặng chạy nền.
 * @param {object} msg tin từ listener ({ sender, content, isGroup, groupName, nguoiGui, isSelf, file, soAnh, msgId, kind, guiLuc })
 */
export function ghiNhanTin(msg) {
    const cfg = cauHinhLich();
    if (!cfg.enabled || msg.isTest) return;
    const khoa = msg.groupName || msg.sender;
    const noiDung = boGioCuoi(msg.content);
    // Trong nhóm: tên thành viên gửi (listener đọc được) thay cho tên nhóm
    const ban = { sender: msg.nguoiGui || msg.sender, content: noiDung, at: msg.guiLuc || Date.now() };   // giờ gửi thật nếu đọc được

    // Tin đến sau file → gom vào các file đang chờ của cùng đoạn chat
    for (const v of viecCho) {
        if (v.khoa === khoa && v.sau.length < cfg.messagesAfter) v.sau.push(ban);
    }

    const truoc = (tinGanDay.get(khoa) || []).slice(-cfg.messagesBefore);
    const the = msg.file ? theTuDom(msg.file) : timTheFile(noiDung);
    if (the) {
        themViecFile(khoa, msg, the, truoc, cfg);
    } else if (msg.soAnh && msg.kind === 'chat') {
        if (cfg.ocrInlineImages) xuLyAnh(msg, khoa, truoc, cfg).catch(e => logger.error('[Lịch] Lỗi đọc ảnh', e.message));
    } else if (cfg.scheduleFromText) {
        theoDoiHoiThoai(khoa, msg, ban, cfg);
    }

    const ds = tinGanDay.get(khoa) || [];
    ds.push(ban);
    if (ds.length > TIN_GAN_DAY_MAX) ds.splice(0, ds.length - TIN_GAN_DAY_MAX);
    tinGanDay.set(khoa, ds);
}

function themViecFile(khoa, msg, the, truoc, cfg) {
    const now = Date.now();
    const k = khoaTen(the.ten);   // khung chat có dung lượng, thanh bên thì không → so theo tên
    if (now - (daThayFile.get(k) || 0) < TRUNG_FILE_MS) return;
    daThayFile.set(k, now);
    for (const [kk, t] of daThayFile) if (now - t > TRUNG_FILE_MS) daThayFile.delete(kk);

    viecCho.push({
        khoa, nguoiGui: msg.nguoiGui || msg.sender, nhom: msg.groupName || '', laNhom: !!msg.isGroup,
        file: the, truoc, sau: [], hanChay: now + cfg.contextWaitSeconds * 1000
    });
    logger.info(`[Lịch] Thấy file "${the.ten}"${the.dungLuong ? ` (${the.dungLuong})` : ''} từ ${msg.nguoiGui || msg.sender} — gom tin nhắn phía sau ${cfg.contextWaitSeconds}s rồi xử lý`);

    // Tải ngay lúc thẻ còn trong khung chat
    if (msg.kind === 'conv') {
        logger.info(`[Lịch] "${the.ten}" chỉ thấy ở thanh bên (đoạn chat không mở) — bot không tự tải, chỉ xét tin nhắn kèm`);
    } else if (docDuocKhong(the.ten) && the.soByte <= cfg.maxFileMB * 1048576) {
        taiTuDong(the).catch(() => {});
    } else {
        logger.info(`[Lịch] Không tải "${the.ten}" (bot không đọc loại này hoặc file quá lớn) — chỉ xét tin nhắn kèm`);
    }
}

function coManhMoi(text) {
    const k = timMocThoiGian(text);
    return k.ngayRo || k.ngayMo || k.gio || k.han;
}

/**
 * Theo dõi đoạn chat có manh mối hẹn. Mọi tin sau đó trong đoạn chat gia hạn chờ, để GLM nhận cả cuộc
 * bàn bạc ("Thứ 7 rảnh không?" → "Rảnh" → "9h ở Highlands nhé" → "Ok") chứ không từng mẩu.
 */
function theoDoiHoiThoai(khoa, msg, ban, cfg) {
    const now = Date.now();
    const manhMoi = coManhMoi(ban.content);
    const chot = CHOT_RE.test(ban.content);
    if (manhMoi) manhMoiGanNhat.set(khoa, now);
    const conNong = now - (manhMoiGanNhat.get(khoa) || 0) < 60 * 60000;
    const doiHuy = HUY_DOI_RE.test(ban.content) && viecMoCuaDoanChat(khoa).length > 0;
    let ht = hoiThoaiCho.get(khoa);
    if (!ht) {
        if (!manhMoi && !(chot && conNong) && !doiHuy) return;
        ht = { batDau: now, coMoi: false };
        hoiThoaiCho.set(khoa, ht);
        logger.info(`[Lịch] Đoạn chat "${khoa}" có manh mối hẹn — chờ hội thoại ngớt ${cfg.conversationQuietSeconds}s rồi gửi GLM ghép lịch`);
    }
    if (manhMoi || chot || doiHuy) ht.coMoi = true;
    ht.hanYen = now + cfg.conversationQuietSeconds * 1000;
    ht.hanCuoi = ht.batDau + cfg.conversationMaxWaitSeconds * 1000;
    ht.nguoi = msg.nguoiGui || msg.sender;
    ht.laNhom = !!msg.isGroup;
}

async function xuLyHoiThoai(khoa, ht, cfg) {
    const now = Date.now();
    while (luotGoiTin.length && now - luotGoiTin[0] > 3600000) luotGoiTin.shift();
    if (luotGoiTin.length >= cfg.maxTextCallsPerHour) {
        logger.warn(`[Lịch] Đã hỏi GLM ${luotGoiTin.length} lần cho tin chữ trong 1 giờ — tạm bỏ qua đoạn chat "${khoa}"`);
        return;
    }
    const tu = now - cfg.conversationWindowMinutes * 60000;
    const hoiThoai = (tinGanDay.get(khoa) || []).filter(t => t.at >= tu).slice(-cfg.conversationMaxMessages);
    if (!hoiThoai.length) return;
    luotGoiTin.push(now);
    const theoMa = new Map(viecMoCuaDoanChat(khoa).map((t, i) => [`V${i + 1}`, t]));
    const viecDaGhi = [...theoMa].map(([ma, t]) => ({ ma, tieu_de: t.title, thoi_gian: moTaDue(t.due), dia_diem: diaDiemCua(t) }));
    logger.info(`[Lịch] Gửi GLM ${hoiThoai.length} tin của đoạn chat "${khoa}" để ghép lịch${viecDaGhi.length ? ` (kèm ${viecDaGhi.length} việc đã ghi để xét đổi / huỷ)` : ''}`);
    const kq = await trichLich({ now: new Date(), nguoiGui: ht.nguoi, nhom: khoa, laNhom: ht.laNhom, hoiThoai, viecDaGhi });
    const nguon = { nguoi_gui: ht.nguoi, nhom: ht.laNhom ? khoa : '', doan_chat: khoa, file: '', loai: 'hoi_thoai' };
    const capNhat = apDungCapNhat(kq?.cap_nhat || [], theoMa, nguon, cfg);   // trước: việc vừa đổi giờ không bị coi là việc mới
    return { ...apDungKetQua(kq, nguon, cfg), capNhat };
}

/** Việc bot đã ghi từ đoạn chat này, chưa xong, hạn từ hôm qua trở đi (tối đa 10) — để GLM xét đổi / huỷ */
function viecMoCuaDoanChat(khoa) {
    const tu = Date.now() - 86400000;
    return listTasks()
        .filter(t => t.status !== 'done' && ['lich', 'zalo'].includes(t.source?.type) && chatCua(t) === khoa
            && (docDue(t.due)?.date.getTime() ?? 0) >= tu)
        .sort((a, b) => String(a.due).localeCompare(String(b.due)))
        .slice(0, 10);
}

/**
 * Áp dụng đổi / huỷ GLM trả về cho việc đã ghi. Huỷ = đánh dấu xong + "❌ Huỷ:" (không xoá, còn dấu vết).
 * @returns {{ loai: 'doi'|'huy', task: object, moTa?: string }[]}
 */
function apDungCapNhat(ds, theoMa, nguon, cfg) {
    const ketQua = [];
    const d = new Date();
    const luc = `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
    for (const cn of ds) {
        const task = theoMa.get(String(cn?.ma || '').trim().toUpperCase());
        if (!task) continue;
        if ((cn.do_chac ?? 0) < cfg.minConfidence) {
            logger.info(`[Lịch] Chưa ${cn.hanh_dong === 'huy' ? 'huỷ' : 'đổi'} "${task.title}": GLM chưa chắc (${cn.do_chac})`);
            continue;
        }
        const lyDo = String(cn.ly_do || '').trim().slice(0, 200);
        const trich = String(cn.trich_dan || '').trim().slice(0, 200);
        try {
            if (cn.hanh_dong === 'huy') {
                const ten = task.title, khi = moTaDue(task.due);   // updateTask sửa thẳng trên object → giữ bản cũ để báo
                const sua = updateTask(task.id, {
                    status: 'done',
                    title: `❌ Huỷ: ${task.title}`.slice(0, 200),
                    note: `${task.note || ''}\n❌ Huỷ lúc ${luc}${lyDo ? `: ${lyDo}` : ''}${trich ? ` “${trich}”` : ''}`.trim().slice(0, 2000)
                });
                ketQua.push({ loai: 'huy', task: sua });
                thongBao('cancelled', `❌ Huỷ lịch: ${ten}`, `${khi}${lyDo ? ` — ${lyDo}` : ''} (${moTaNguon(nguon)})`);
                guiYuyuko('thong_bao', { noi_dung: `Chủ nhân ơi, "${ten}" (${khi}) bị huỷ rồi nha.` });
                logger.info(`[Lịch] ❌ Huỷ "${ten}" (${khi})${lyDo ? ` — ${lyDo}` : ''}`);
            } else if (cn.hanh_dong === 'doi') {
                // GLM bỏ trống giờ khi chỉ đổi ngày / địa điểm → giữ giờ cũ (không biến hẹn có giờ thành "cả ngày")
                const gioCu = task.due.includes('T') ? task.due.slice(11, 16) : '';
                const { ev, loi } = chuanHoa({
                    tieu_de: task.title, ngay: cn.ngay || task.due.slice(0, 10), gio: cn.gio || gioCu,
                    gio_ket_thuc: cn.gio_ket_thuc, dia_diem: cn.dia_diem
                }, new Date());
                if (!ev) { logger.info(`[Lịch] Không đổi "${task.title}": ${loi}`); continue; }
                const choCu = diaDiemCua(task);
                const doiGio = ev.due !== task.due;
                const doiCho = !!ev.dia_diem && ev.dia_diem !== choCu;
                if (!doiGio && !doiCho) continue;
                let note = task.note || '';
                if (doiCho) note = choCu ? note.replace(/^📍 .*$/m, `📍 ${ev.dia_diem}`) : `📍 ${ev.dia_diem}\n${note}`;
                const moTa = [
                    doiGio ? `${moTaDue(task.due)} → ${moTaDue(ev.due, ev.gio_ket_thuc)}` : '',
                    doiCho ? `${choCu || '(chưa có chỗ)'} → ${ev.dia_diem}` : ''
                ].filter(Boolean).join('; ');
                note = `${note}\n🔁 Đổi lịch lúc ${luc}: ${moTa}${lyDo ? ` — ${lyDo}` : ''}`.trim().slice(0, 2000);
                const ten = task.title;
                const sua = updateTask(task.id, { due: ev.due, note });
                ketQua.push({ loai: 'doi', task: sua, moTa });
                thongBao('updated', `🔁 Đổi lịch: ${ten}`, `${moTa} (${moTaNguon(nguon)})`);
                guiYuyuko('thong_bao', { noi_dung: `Chủ nhân ơi, "${ten}" đổi lịch rồi: ${moTa}.` });
                logger.info(`[Lịch] 🔁 Đổi "${ten}": ${moTa}${lyDo ? ` — ${lyDo}` : ''}`);
            }
        } catch (e) {
            logger.warn(`[Lịch] Không sửa được "${task.title}": ${e.message}`);
        }
    }
    return ketQua;
}

/**
 * Xử lý một file (có hoặc chưa có nội dung) cùng ngữ cảnh tin nhắn.
 * opts.chiXem = true: chỉ trả kết quả GLM, không tạo công việc / không báo giao diện, Yuyuko.
 */
export async function xuLyFile(job, cfg, opts = {}) {
    const ten = job.file.ten;
    const duong = job.laAnh ? null : (job.duong || timFileDaCo(ten));
    let doc = job.vanBan ? { ok: true, text: job.vanBan } : null;   // ảnh: chữ đã OCR sẵn
    if (!doc && duong) {
        try {
            doc = await docFile(duong, { maxMB: cfg.maxFileMB, ocrLang: cfg.ocrLang });
        } catch (e) {
            doc = { ok: false, ghiChu: e.message };
        }
        logger.info(`[Lịch] Đọc "${ten}": ${doc.ok ? `${doc.text.length} ký tự${doc.ghiChu ? ` (${doc.ghiChu})` : ''}` : `không được — ${doc.ghiChu}`}`);
    }
    const coChu = !!(doc?.ok && doc.text.trim());
    const trich = coChu ? doc.text.slice(0, 1500) : '';
    const ctx = { now: new Date(), nguoiGui: job.nguoiGui, nhom: job.nhom, laNhom: job.laNhom, truoc: job.truoc, sau: job.sau, file: job.file };
    const laFileAnh = !!duong && /\.(png|jpe?g|webp|bmp)$/i.test(duong);
    const nguon = { nguoi_gui: job.nguoiGui, nhom: job.nhom || '', doan_chat: job.khoa || '', file: ten, loai: job.laAnh || laFileAnh ? 'anh' : 'file' };

    // OCR không đọc được ảnh → gửi ảnh thẳng cho GLM
    let anh = job.anh || null;
    if (!anh && !coChu && laFileAnh && cfg.visionFallback && fs.statSync(duong).size <= cfg.maxFileMB * 1048576) {
        anh = [{ b64: fs.readFileSync(duong).toString('base64'), mime: MIME_ANH[path.extname(duong).slice(1).toLowerCase()] }];
    }
    if (anh?.length) {
        if (job.laAnh && !coDauHieuLich(job)) {
            logger.info(`[Lịch] "${ten}" từ ${job.nguoiGui}: tin nhắn quanh ảnh không nhắc lịch — không gửi ảnh cho GLM`);
            return { lyDo: 'ảnh không kèm dấu hiệu lịch' };
        }
        logger.info(`[Lịch] Gửi ${anh.length} ảnh "${ten}" cho GLM đọc (không có chữ OCR)`);
        const kq = await trichLich({ ...ctx, anh });
        if (opts.chiXem) return { kq, docCaFile: true, quaAnh: true };
        return { kq, docCaFile: true, quaAnh: true, ...apDungKetQua(kq, nguon, cfg) };
    }

    let docCaFile = coChu && nenGuiGLM(timMocThoiGian(doc.text), true);
    if (!docCaFile) {
        if (!coChu && job.truoc.length + job.sau.length === 0) {
            if (!duong) giuChoFile(job);
            logger.info(`[Lịch] "${ten}": chưa có nội dung file, cũng không có tin nhắn kèm — ${duong ? 'bỏ qua' : 'chờ file'}`);
            return { lyDo: 'không có gì để xét' };
        }
        const dg = await danhGiaFile({ ...ctx, trich });
        logger.info(`[Lịch] GLM xét "${ten}": ${dg.doc_file ? 'NÊN đọc file' : 'không cần đọc file'}${dg.co_lich_trong_tin ? ', tin nhắn có lịch' : ''} — ${dg.ly_do}`);
        if (dg.doc_file && !coChu && !duong && !opts.chiXem) {
            giuChoFile(job);
            baoCanFile(job, dg.ly_do);
        }
        docCaFile = dg.doc_file && coChu;
        if (!docCaFile && !dg.co_lich_trong_tin) return { lyDo: dg.ly_do, danhGia: dg };
    }

    const kq = await trichLich({ ...ctx, fileText: docCaFile ? doc.text.slice(0, cfg.maxFileChars) : null, trich });
    if (opts.chiXem) return { kq, docCaFile };
    return { kq, docCaFile, ...apDungKetQua(kq, nguon, cfg) };
}

function baoCanFile(job, lyDo) {
    thongBao('need-file', `📎 File "${job.file.ten}" ${moTaNguon({ nguoi_gui: job.nguoiGui, nhom: job.nhom })} có vẻ chứa lịch`,
        `${lyDo} — bấm tải trong trình duyệt của bot, hoặc lưu file (giữ nguyên tên) vào ${DROP_DIR} trong 24 giờ là bot tự đọc.`);
    guiYuyuko('thong_bao', { noi_dung: `Có file "${job.file.ten}" trên Zalo hình như chứa lịch, Chủ nhân tải giúp Yuyuko nhé!` });
}

/**
 * Việc GLM tìm được → công việc (nguồn "lich"). Bỏ việc không dành cho Chủ nhân, không chắc, đã qua,
 * hoặc đã có (cùng tiêu đề bỏ dấu + cùng hạn — kể cả việc AI phân tích tin hay Chủ nhân tạo tay).
 */
function apDungKetQua(kq, nguon, cfg) {
    const tatCa = kq?.su_kien || [];
    const chon = tatCa.filter(ev => ev.danh_cho_chu_nhan && (ev.do_chac ?? 0) >= cfg.minConfidence);
    // Đoạn chat của một việc đã có: việc lịch ghi source.chat; việc AI phân tích tin ghi source.sender = tên đoạn chat
    const daCo = listTasks().map(t => ({ title: t.title, due: t.due, chat: chatCua(t) }));
    const doanChat = nguon.doan_chat || '';
    const them = [];
    const loi = [];
    for (const raw of chon) {
        const { ev, loi: e } = chuanHoa(raw, new Date());
        if (!ev) { loi.push(`${raw?.tieu_de || '?'}: ${e}`); continue; }
        const k = khoaTrung(ev.tieu_de, ev.due);
        const trung = daCo.find(t => giongViec(t, { title: ev.tieu_de, due: ev.due }) || (doanChat && t.chat === doanChat && t.due === ev.due));
        if (trung) { loi.push(`${ev.tieu_de}: đã có trong công việc ("${trung.title}")`); continue; }
        daCo.push({ title: ev.tieu_de, due: ev.due, chat: doanChat });
        const note = [
            ev.gio_ket_thuc ? `Đến ${ev.gio_ket_thuc}` : '',
            ev.dia_diem ? `📍 ${ev.dia_diem}` : '',
            ev.ghi_chu,
            ev.trich_dan ? `“${ev.trich_dan}”` : '',
            `Nguồn: ${moTaNguon(nguon)}`
        ].filter(Boolean).join('\n').slice(0, 2000);
        try {
            const task = createTask({ title: ev.tieu_de, note, due: ev.due, priority: 'medium' }, {
                type: 'lich',
                sender: String(nguon.nguoi_gui || '').slice(0, 200),
                group: String(nguon.nhom || '').slice(0, 200),
                chat: String(doanChat).slice(0, 200),
                file: String(nguon.file || '').slice(0, 200),
                kind: nguon.loai,
                content: ev.trich_dan,
                dedupeKey: crypto.createHash('md5').update(`lich:::${k}`).digest('hex')
            });
            if (task) them.push({ task, ev });
        } catch (err) {
            loi.push(`${ev.tieu_de}: ${err.message}`);
        }
    }
    if (loi.length) logger.info(`[Lịch] Không thêm: ${loi.join('; ')}`);
    if (!them.length) {
        const bo = tatCa.length - chon.length;
        logger.info(`[Lịch] Không có việc mới từ ${moTaNguon(nguon)}${bo ? ` (bỏ ${bo} việc không chắc / không dành cho Chủ nhân / chưa chốt)` : ''}`);
        return { them: [], loi };
    }

    const dong = them.map(({ task, ev }) => `${moTaDue(task.due, ev.gio_ket_thuc)} — ${task.title}${ev.dia_diem ? ` (${ev.dia_diem})` : ''}`);
    thongBao('scheduled', `🗓️ Đã lên lịch ${them.length} việc ${moTaNguon(nguon)}`, dong.slice(0, 5).join(' · ') + (dong.length > 5 ? ' …' : ''));
    guiYuyuko('thong_bao', { noi_dung: `Yuyuko vừa ghi ${them.length} việc từ Zalo vào lịch: ${them.slice(0, 3).map(x => x.task.title).join('; ')}${them.length > 3 ? '...' : ''}` });
    for (const { task, ev } of them) {
        const [ngay, gioPhut] = task.due.split('T');
        const [gio, phut] = gioPhut ? gioPhut.split(':').map(Number) : [7, 0];
        guiYuyuko('lich_moi', { tieu_de: task.title, ghi_chu: [ev.dia_diem, ev.ghi_chu].filter(Boolean).join(' — '), ngay, gio, phut });
    }
    logger.info(`[Lịch] 🗓️ Đã lên lịch ${them.length} việc: ${dong.join(' | ')}`);
    return { them: them.map(x => x.task), loi };
}

function chayViecDenHan(cfg) {
    const now = Date.now();
    for (const [khoa, ht] of hoiThoaiCho) {
        if (now < ht.hanYen && now < ht.hanCuoi) continue;
        hoiThoaiCho.delete(khoa);
        if (ht.coMoi) xuLyHoiThoai(khoa, ht, cfg).catch(e => logger.error(`[Lịch] Lỗi ghép lịch đoạn chat "${khoa}"`, e.message));
    }
    for (let i = viecCho.length - 1; i >= 0; i--) {
        if (viecCho[i].hanChay > now) continue;
        const job = viecCho.splice(i, 1)[0];
        xuLyFile(job, cfg).catch(e => logger.error(`[Lịch] Lỗi xử lý file "${job.file.ten}"`, e.message));
    }
    for (let i = choFile.length - 1; i >= 0; i--) {
        if (now - choFile[i].luc > CHO_FILE_MS) choFile.splice(i, 1);
    }
}

// Chủ nhân thả file vào data/hop_file → ghép với thẻ file đang chờ (cùng tên) hoặc đọc riêng
function quetHopFile(cfg) {
    let ten;
    try { ten = fs.readdirSync(DROP_DIR); } catch (e) { return; }
    for (const name of ten) {
        const full = path.join(DROP_DIR, name);
        if (dangXuLyTay.has(full)) continue;
        let st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (!st.isFile() || Date.now() - st.mtimeMs < 3000) continue;     // đang chép dở

        // File đang trong lúc gom tin nhắn phía sau → gắn file vào đó, đọc cùng lúc khi hết giờ chờ
        const dangGom = viecCho.find(j => !j.duong && !j.laAnh && khoaTen(j.file.ten) === khoaTen(name));
        const i = dangGom ? -1 : choFile.findIndex(j => khoaTen(j.file.ten) === khoaTen(name));
        const job = i >= 0 ? choFile.splice(i, 1)[0] : {
            khoa: 'tay', nguoiGui: 'Chủ nhân (thả file tay)', nhom: '', laNhom: false,
            file: { ten: name, dungLuong: '' }, truoc: [], sau: []
        };
        // Chuyển sang kho đã đọc TRƯỚC khi xử lý, để file lỗi không bị đọc lại mãi
        const dich = path.join(FILES_DIR, 'da_doc', homNay());
        const moi = path.join(dich, `${Date.now()}_${safeName(name)}`);
        try {
            fs.mkdirSync(dich, { recursive: true });
            fs.renameSync(full, moi);
        } catch (e) {
            logger.warn(`[Lịch] Chưa chuyển được "${name}" (file đang mở?): ${e.message}`);
            if (i >= 0) choFile.push(job);
            continue;
        }
        if (dangGom) {
            dangGom.duong = moi;
            logger.info(`[Lịch] Nhận file thả tay "${name}" — đọc cùng tin nhắn kèm khi hết giờ chờ`);
            continue;
        }
        job.duong = moi;
        dangXuLyTay.add(full);
        logger.info(`[Lịch] Đọc file thả tay "${name}"${i >= 0 ? ` (ghép với file từ ${job.nguoiGui})` : ''}`);
        xuLyFile(job, cfg)
            .catch(e => logger.error(`[Lịch] Lỗi xử lý file "${name}"`, e.message))
            .finally(() => dangXuLyTay.delete(full));
    }
}

/** Vòng việc chờ + hộp file thả tay. Chạy cả khi --ui-only (thả file vẫn được đọc). */
export function khoiDongLichTuDong() {
    if (daKhoiDong) return;
    daKhoiDong = true;
    fs.mkdirSync(DROP_DIR, { recursive: true });
    fs.mkdirSync(FILES_DIR, { recursive: true });
    setInterval(() => { try { chayViecDenHan(cauHinhLich()); } catch (e) { logger.error('[Lịch] Lỗi vòng việc chờ', e.message); } }, JOB_TICK_MS);
    setInterval(() => { try { quetHopFile(cauHinhLich()); } catch (e) { logger.error('[Lịch] Lỗi quét hop_file', e.message); } }, DROP_TICK_MS);
    const cfg = cauHinhLich();
    logger.info(`🗓️ Lịch tự động: ${cfg.enabled ? `BẬT (${cfg.model})` : 'TẮT'} — thả file vào ${DROP_DIR} để bot đọc tay`);
}

// Cho test — không dùng trong bot
export const _noiBo = { taiTuDong, layAnhTrongTin, apDungKetQua, chayViecDenHan: () => chayViecDenHan(cauHinhLich()) };
