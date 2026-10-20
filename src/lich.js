import { removeVietnameseTones } from './filter.js';

/**
 * Hàm thuần về ngày giờ cho lịch tự động: chuẩn hoá việc GLM trả về thành hạn chót của công việc
 * ('YYYY-MM-DDTHH:mm' hoặc 'YYYY-MM-DD' — cùng dạng tasks.js dùng), mô tả mốc bằng tiếng Việt.
 */

const MAX_AHEAD_MS = 400 * 86400 * 1000;
const THU = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const pad = n => String(n).padStart(2, '0');
const cat = (s, n) => String(s || '').trim().slice(0, n);

// GLM hay trả "16/10/2026" dù khuôn đã dặn YYYY-MM-DD (đo 30/09: 2/3 lượt) — nhận cả hai dạng
export function parseNgay(s) {
    const t = String(s || '').trim();
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return [+m[1], +m[2], +m[3]];
    m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) return [+m[3], +m[2], +m[1]];
    return null;
}

export function parseGio(s) {
    const m = String(s || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    return m ? { h: +m[1], p: +m[2], text: `${pad(+m[1])}:${m[2]}` } : null;
}

/** Hạn chót ('YYYY-MM-DD' | 'YYYY-MM-DDTHH:mm') → { date, coGio } theo giờ máy; sai dạng → null */
export function docDue(due) {
    const m = String(due || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
    if (!m) return null;
    const coGio = m[4] !== undefined;
    return { date: new Date(+m[1], +m[2] - 1, +m[3], coGio ? +m[4] : 0, coGio ? +m[5] : 0), coGio };
}

/** "08:30 Chủ nhật 11/10/2026" hoặc "cả ngày Thứ Bảy 10/10/2026" */
export function moTaDue(due, gioKetThuc = '') {
    const d = docDue(due);
    if (!d) return 'chưa có hạn';
    const t = d.date;
    const ngay = `${THU[t.getDay()]} ${pad(t.getDate())}/${pad(t.getMonth() + 1)}/${t.getFullYear()}`;
    if (!d.coGio) return `cả ngày ${ngay}`;
    return `${pad(t.getHours())}:${pad(t.getMinutes())}${gioKetThuc ? `–${gioKetThuc}` : ''} ${ngay}`;
}

/** Khoá chống trùng: tiêu đề bỏ dấu + hạn chót */
export function khoaTrung(tieuDe, due) {
    return `${removeVietnameseTones(tieuDe).replace(/[^a-z0-9]+/g, ' ').trim()}|${due || ''}`;
}

const tuCuaTen = s => new Set(removeVietnameseTones(s).split(/[^a-z0-9]+/).filter(Boolean));

/**
 * Hai việc cùng hạn chót có phải một không: tên này chứa trọn các từ của tên kia ("Họp phụ huynh" ⊂
 * "Họp phụ huynh lớp 12A"), hoặc trùng ít nhất một nửa số từ ("Học bù Vật lý lớp 12A" ~ "Học bù Vật lý
 * (phòng 108)"). "Thi Toán" và "Thi Văn" cùng giờ vẫn là hai việc.
 */
export function giongViec(a, b) {
    if ((a.due || '') !== (b.due || '')) return false;
    const x = tuCuaTen(a.title), y = tuCuaTen(b.title);
    if (!x.size || !y.size) return false;
    let chung = 0;
    for (const t of x) if (y.has(t)) chung++;
    return chung === Math.min(x.size, y.size) || chung / (x.size + y.size - chung) >= 0.5;
}

/**
 * Kiểm một việc GLM trả về: ngày có thật, chưa qua, không xa quá 400 ngày.
 * @returns {{ ev?: { tieu_de, due, gio_ket_thuc, dia_diem, ghi_chu, trich_dan, do_chac }, loi?: string }}
 */
export function chuanHoa(ev, now = new Date()) {
    const ngay = parseNgay(ev?.ngay);
    if (!ngay) return { loi: `ngày "${ev?.ngay}" sai định dạng` };
    const [y, mo, d] = ngay;
    const day = new Date(y, mo - 1, d);
    if (day.getFullYear() !== y || day.getMonth() !== mo - 1 || day.getDate() !== d) {
        return { loi: `ngày ${ev.ngay} không có thật` };
    }
    const tieuDe = cat(ev.tieu_de, 200);
    if (!tieuDe) return { loi: 'thiếu tiêu đề' };

    const g = parseGio(ev.gio);
    const gk = parseGio(ev.gio_ket_thuc);
    const ngayStr = `${y}-${pad(mo)}-${pad(d)}`;
    const out = {
        tieu_de: tieuDe,
        due: g ? `${ngayStr}T${g.text}` : ngayStr,
        gio_ket_thuc: g && gk ? gk.text : '',
        dia_diem: cat(ev.dia_diem, 200),
        ghi_chu: cat(ev.ghi_chu, 500),
        trich_dan: cat(ev.trich_dan, 300),
        do_chac: typeof ev.do_chac === 'number' ? ev.do_chac : 0.5
    };
    const batDau = new Date(y, mo - 1, d, g ? g.h : 0, g ? g.p : 0).getTime();
    const hetLuc = g ? batDau : new Date(y, mo - 1, d, 23, 59).getTime();
    if (hetLuc < now.getTime() - 5 * 60000) return { loi: `${ngayStr} ${g ? g.text : ''} đã qua`.trim() };
    if (batDau - now.getTime() > MAX_AHEAD_MS) return { loi: `${ngayStr} xa quá 400 ngày` };
    return { ev: out };
}
