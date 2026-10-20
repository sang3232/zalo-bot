/**
 * Dò mốc ngày / giờ trong chữ tiếng Việt — có dấu, không dấu, hay chữ OCR đã mất dấu.
 * Chạy trên máy, không tốn tiền: chỉ để LỌC TRƯỚC xem có đáng gửi GLM đọc kỹ không.
 * Không quy ra ngày thật ở đây — việc đó để GLM làm vì nó hiểu "thứ 6 tuần sau".
 */

// Ranh giới từ theo Unicode: \b của JS chỉ hiểu chữ ASCII nên hỏng với "tư", "năm"...
const L = String.raw`(?<![\p{L}\p{N}])`;
const R = String.raw`(?![\p{L}\p{N}])`;
const w = (src) => new RegExp(L + src + R, 'gu');

const validDM = (d, m) => d >= 1 && d <= 31 && m >= 1 && m <= 12;

const NGAY = '(?:ngày|ngay)';
const THANG = '(?:tháng|thang)';
const NAM = '(?:năm|nam)';

// kind: ngay = ngày rõ ràng; thu / tuong_doi = ngày mơ hồ; gio = giờ; han = hạn chót, lịch thi...
const PATTERNS = [
    { kind: 'ngay', re: w(String.raw`(20\d{2})-(\d{1,2})-(\d{1,2})`), ok: m => validDM(+m[3], +m[2]) },
    { kind: 'ngay', re: w(String.raw`(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}|\d{2}))?`), ok: m => validDM(+m[1], +m[2]) },
    { kind: 'ngay', re: w(String.raw`(\d{1,2})\.(\d{1,2})\.(\d{4})`), ok: m => validDM(+m[1], +m[2]) },
    { kind: 'ngay', re: w(String.raw`(?:${NGAY}\s+)?(\d{1,2})\s+${THANG}\s+(\d{1,2})`), ok: m => validDM(+m[1], +m[2]) },
    { kind: 'ngay', re: w(String.raw`${NGAY}\s+(\d{1,2})`), ok: m => +m[1] >= 1 && +m[1] <= 31 },
    { kind: 'ngay', re: w(String.raw`${THANG}\s+(\d{1,2})\s*(?:\/|${NAM})\s*(\d{4})`), ok: m => +m[1] >= 1 && +m[1] <= 12 },
    // "thứ tự" KHÔNG khớp vì "tự" không phải "tư"
    { kind: 'thu', re: w(String.raw`(?:thứ|thu)\s*(?:hai|ba|tư|tu|năm|nam|sáu|sau|bảy|bay|[2-7])|(?:chủ|chu)\s*(?:nhật|nhat)`) },
    { kind: 'tuong_doi', re: w(String.raw`(?:hôm|hom)\s+nay|${NGAY}\s+(?:mai|kia|mốt|mot)|(?:sáng|sang|trưa|trua|chiều|chieu|tối|toi|đêm|dem)\s+(?:nay|mai|mốt|mot)|(?:tuần|tuan|${THANG})\s+(?:này|nay|sau|tới|toi)|(?:cuối|cuoi|đầu|dau)\s+(?:tuần|tuan|${THANG})`) },
    { kind: 'gio', re: w(String.raw`(\d{1,2})\s*(?:h|g|giờ|gio)(?:\s*(\d{1,2})\s*(?:p|phút|phut)?)?`), ok: m => +m[1] <= 23 && (m[2] === undefined || +m[2] <= 59) },
    { kind: 'gio', re: w(String.raw`(\d{1,2}):(\d{2})`), ok: m => +m[1] <= 23 && +m[2] <= 59 },
    { kind: 'han', re: w(String.raw`(?:hạn|han)\s+(?:chót|chot|nộp|nop)|(?:hết|het)\s+(?:hạn|han)|deadline|(?:lịch|lich)\s+(?:thi|họp|hop|học|hoc|trực|truc|công tác|cong tac|làm việc|lam viec)|thời khoá biểu|thời khóa biểu|thoi khoa bieu|(?:giấy|giay|thư|thu)\s+(?:mời|moi)`) },
];

// Chữ báo đây là việc cần có mặt / cần làm (dùng cho tin nhắn chữ, không dùng cho file)
const TU_LICH = w(String.raw`họp|hop|thi|nộp|nop|hẹn|hen|lịch|lich|nhắc|nhac|kiểm tra|kiem tra|báo cáo|bao cao|sự kiện|su kien|khai giảng|khai giang|đăng ký|dang ky|phỏng vấn|phong van|trực|truc|khám|kham|tiệc|tiec|cưới|đám|gặp|gap`);

/**
 * @returns {{ hits: {kind: string, index: number, text: string}[], ngayRo: boolean, ngayMo: boolean, gio: boolean, han: boolean, tuLich: boolean }}
 */
export function timMocThoiGian(text) {
    const s = String(text || '').normalize('NFC').toLowerCase();
    const hits = [];
    for (const p of PATTERNS) {
        for (const m of s.matchAll(p.re)) {
            if (p.ok && !p.ok(m)) continue;
            hits.push({ kind: p.kind, index: m.index, text: m[0] });
        }
    }
    hits.sort((a, b) => a.index - b.index);
    const has = k => hits.some(h => h.kind === k);
    TU_LICH.lastIndex = 0;
    return {
        hits,
        ngayRo: has('ngay'),
        ngayMo: has('thu') || has('tuong_doi'),
        gio: has('gio'),
        han: has('han'),
        tuLich: TU_LICH.test(s)
    };
}

/**
 * Có đáng tốn một lượt GLM không.
 * - File: phải có ngày rõ ràng hoặc chữ kiểu "hạn nộp", "lịch thi". Chỉ có "thứ Tư" thì để GLM
 *   xem tên file + tin nhắn kèm rồi mới quyết có đọc cả file không.
 * - Tin nhắn chữ: "hôm nay mệt quá" không đủ — cần ngày rõ, hoặc ngày mơ hồ / giờ đi kèm việc.
 */
export function nenGuiGLM(kq, laFile) {
    if (!kq) return false;
    if (laFile) return kq.ngayRo || kq.han;
    // Tin chữ: "xem lịch thi nhé" (có chữ lịch mà không có ngày giờ) không đáng một lượt GLM
    return kq.ngayRo || ((kq.ngayMo || kq.gio) && (kq.ngayMo && kq.gio || kq.tuLich || kq.han));
}

/**
 * Cắt các đoạn quanh mốc thời gian (để GLM xem nhanh mà không gửi cả file)
 */
export function trichDoan(text, hits, banKinh = 150, toiDa = 8) {
    const s = String(text || '');
    const vung = [];
    for (const h of hits) {
        const a = Math.max(0, h.index - banKinh);
        const b = Math.min(s.length, h.index + h.text.length + banKinh);
        const cuoi = vung[vung.length - 1];
        if (cuoi && a <= cuoi[1]) cuoi[1] = Math.max(cuoi[1], b);
        else vung.push([a, b]);
        if (vung.length >= toiDa) break;
    }
    return vung.map(([a, b]) => s.slice(a, b).replace(/\s+/g, ' ').trim()).join(' … ');
}
