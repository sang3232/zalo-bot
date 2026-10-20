// Soi cấu trúc Zalo Web bằng phiên của bot — CHỈ lấy khung trang (thẻ, class, nút), chữ tin nhắn bị che.
//   npm run soi-zalo              (kết quả trong logs/soi_zalo/)
//   node tools/soi_zalo.mjs <thư_mục_ra>
// Dùng khi Zalo đổi giao diện và bot không bắt được tin: so kết quả với bộ chọn SEL trong src/listener.js.
// Không chụp màn hình, không tải file, chỉ mở chat "Cloud của tôi" / "My Documents" (chat với chính mình).
// TẮT bot trước khi chạy: hai trình duyệt không dùng chung được thư mục user_data.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '../logs/soi_zalo'));
fs.mkdirSync(OUT, { recursive: true });
const logFile = path.join(OUT, 'soi.log');
const log = (s) => {
    const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${s}`;
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
};
const save = (name, text) => {
    fs.writeFileSync(path.join(OUT, name), text, 'utf-8');
    log(`Đã lưu ${name} (${text.length} ký tự)`);
};

// ───────────── chạy TRONG trang: mọi hàm phụ nằm bên trong để Playwright gửi nguyên khối ─────────────
function soiTrang({ viec, tenChat }) {
    const UI_RE = /tải|download|xem|mở|lưu|chia sẻ|chuyển tiếp|trả lời|thu hồi|xoá|xóa|ghim|sao chép|copy|thêm|tuỳ chọn|tùy chọn|more|option|reply|forward|share|cảm xúc|react|gọi|call|video|tìm|search|đóng|close|nhóm|group|cloud|thông tin|info|hôm nay|hôm qua|đã gửi|đã nhận|đã xem|tin nhắn|hình ảnh|ảnh|file|tệp|sticker|link|mới|new|chưa đọc|unread|ưu tiên|khác|tất cả|phân loại|của tôi/gi;
    const chuCai = s => s.replace(/[^\p{L}]/gu, '');
    const laUI = (s) => {
        const t = s.trim();
        if (!t || t.length > 26) return false;
        const conLai = chuCai(t.replace(UI_RE, ''));
        return conLai.length <= 8 && conLai.length < chuCai(t).length;
    };
    const anChu = (s) => {
        const t = s.replace(/\s+/g, ' ').trim();
        if (!t) return null;
        if (/^\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB)$/i.test(t)) return '«dung_lượng»';
        const ext = t.match(/\.([a-z0-9]{2,5})$/i);
        if (ext && t.length <= 80 && !/\s{2}/.test(t)) return `«đuôi_tên_file .${ext[1].toLowerCase()}»`;
        if (/^\d{1,2}:\d{2}$/.test(t)) return '«giờ»';
        if (/^(?:\d{1,2}:\d{2}\s*)?(?:hôm nay|hôm qua)$/i.test(t)) return `"${t}"`;
        if (/\d{1,2}\/\d{1,2}/.test(t) && t.length <= 30) return '«ngày»';
        if (laUI(t)) return `"${t}"`;
        return `«chữ ${t.length}»`;
    };
    const attrUI = (v) => laUI(v) ? v.slice(0, 40) : `«${v.length}»`;
    const moTa = (el) => {
        let s = el.tagName.toLowerCase();
        if (el.id) s += '#' + (/\d{5,}/.test(el.id) ? '«id-số»' : el.id);
        const cls = (el.getAttribute('class') || '').trim();
        if (cls) s += '.' + cls.split(/\s+/).slice(0, 8).join('.');
        const at = [];
        for (const a of el.attributes) {
            if (['id', 'class', 'style'].includes(a.name)) continue;
            if (a.name.startsWith('data-translate')) at.push(`${a.name}=${a.value.slice(0, 60)}`);
            else if (['title', 'aria-label', 'placeholder', 'alt'].includes(a.name)) at.push(`${a.name}=${attrUI(a.value)}`);
            else if (a.name === 'src' || a.name === 'href') at.push(`${a.name}=${a.value.split(':')[0]}:…`);
            else if (a.name.startsWith('data-') || ['role', 'type', 'draggable', 'tabindex', 'contenteditable'].includes(a.name)) {
                at.push(`${a.name}=${/^[\w-]{0,30}$/.test(a.value) && !/\d{5,}/.test(a.value) ? a.value : `«${a.value.length}»`}`);
            }
        }
        if (at.length) s += ' [' + at.join(' ') + ']';
        return s;
    };
    const chuRieng = (el) => [...el.childNodes].filter(n => n.nodeType === 3).map(n => anChu(n.textContent)).filter(Boolean).join(' ');
    const sig = (el) => el.tagName + '.' + (el.getAttribute('class') || '');
    const dump = (root, maxDepth = 25, maxLines = 3000, giuCuoi = 3) => {
        if (!root) return '(không tìm thấy)';
        const lines = [];
        const walk = (el, d) => {
            if (lines.length >= maxLines) return;
            const txt = chuRieng(el);
            lines.push('  '.repeat(d) + moTa(el) + (txt ? '  ' + txt : ''));
            if (d >= maxDepth) { if (el.children.length) lines.push('  '.repeat(d + 1) + `… (${el.children.length} con)`); return; }
            const kids = [...el.children];
            let i = 0;
            while (i < kids.length) {
                let j = i;
                while (j < kids.length && sig(kids[j]) === sig(kids[i])) j++;
                const n = j - i;
                const hien = n > giuCuoi + 1 ? [kids[i], ...kids.slice(j - giuCuoi, j)] : kids.slice(i, j);
                hien.forEach((k, idx) => {
                    if (n > giuCuoi + 1 && idx === 1) lines.push('  '.repeat(d + 1) + `… (bỏ ${n - 1 - giuCuoi} phần tử giống nhau)`);
                    walk(k, d + 1);
                });
                i = j;
            }
        };
        walk(root, 0);
        return lines.join('\n');
    };
    const duongDi = (el) => {
        const p = [];
        for (let e = el; e && e !== document.body; e = e.parentElement) {
            let s = e.tagName.toLowerCase();
            if (e.id && !/\d{5,}/.test(e.id)) s += '#' + e.id;
            const c = (e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
            if (c.length) s += '.' + c.join('.');
            p.unshift(s);
        }
        return p.join(' > ');
    };
    const danhSachLap = (x, y, toiThieu = 4) => {
        let el = document.elementFromPoint(x, y);
        while (el && el !== document.body) {
            const kids = [...el.children];
            if (kids.length >= toiThieu) {
                const dem = {};
                kids.forEach(k => { dem[sig(k)] = (dem[sig(k)] || 0) + 1; });
                if (Math.max(...Object.values(dem)) >= toiThieu) return el;
            }
            el = el.parentElement;
        }
        return null;
    };
    const tinhAnhEm = (x, y, capLen) => {
        let el = document.elementFromPoint(x, y);
        for (let i = 0; i < capLen && el && el.parentElement && el.parentElement !== document.body; i++) el = el.parentElement;
        return el;
    };
    const laLa = (el) => el.childElementCount === 0;

    const out = {};
    if (viec === 'tong_quan') {
        const cu = ['.conv-item', '.conv-item-title__name', '.conv-item__name', '.conv-message', '.conv-item-last-msg', '.msg-info', '.conv-time',
            '.header-title .title', '#chatViewHeader', '#chatViewHeader .header-title', '.chat-view-header .truncate', '.truncate',
            '.card', '.bubble-msg', '.chat-message', '.chat-item', '.text', '.msg-content', '.me', '.is-me', '.chat-item--right',
            '.chat-date', '.chat-date-container', '.date-divider', 'div[data-date]', '#conv-list', '#chatView', '#main-tab', '#messageViewScroll'];
        out.selectorCu = cu.map(s => `${String(document.querySelectorAll(s).length).padStart(5)}  ${s}`).join('\n');
        out.khungTrang = dump(document.body, 9, 1500, 2);
        const ds = danhSachLap(200, 300);
        out.thanhBen = `ĐƯỜNG ĐI: ${ds ? duongDi(ds) : '-'}\n\n` + dump(ds, 14, 1500, 3);
        // tìm tên "Cloud của tôi" ở thanh bên (tên hệ thống, không phải tin riêng)
        const la = [...document.querySelectorAll('div, span')].filter(e => laLa(e) && /^(cloud của tôi|my cloud|my documents)$/i.test(e.textContent.trim()));
        out.cloud = la.map(e => duongDi(e)).join('\n') || '(không thấy "Cloud của tôi" trên thanh bên)';
        return out;
    }

    if (viec === 'mo_cloud') {
        const la = [...document.querySelectorAll('div, span')].filter(e => laLa(e) && /^(cloud của tôi|my cloud|my documents)$/i.test(e.textContent.trim()));
        const ben = la.find(e => e.getBoundingClientRect().left < 420);
        if (!ben) return { ok: false };
        ben.click();
        return { ok: true, ten: ben.textContent.trim() };
    }

    if (viec === 'khung_chat') {
        // Tiêu đề: phần tử lá mang đúng tên chat đang mở, nằm phía trên, bên phải thanh bên
        const tieuDe = [...document.querySelectorAll('div, span, h1, h2, h3')]
            .filter(e => laLa(e) && e.textContent.trim() === tenChat)
            .filter(e => { const r = e.getBoundingClientRect(); return r.left > 380 && r.top < 90; });
        out.tieuDe = tieuDe.map(e => duongDi(e)).join('\n') || '(không thấy phần tử tiêu đề)';
        out.dauKhung = dump(tinhAnhEm(760, 30, 5), 12, 400, 3);
        const ds = danhSachLap(800, 420);
        out.dsTin = `ĐƯỜNG ĐI: ${ds ? duongDi(ds) : '-'}\n\n` + dump(ds, 22, 2500, 5);

        const theFile = [...document.querySelectorAll('*')].filter(e => laLa(e) && /^\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB)$/i.test(e.textContent.trim()))
            .filter(e => e.getBoundingClientRect().left > 380).slice(-3);
        out.theFile = theFile.map((e, i) => {
            let khung = e;
            for (let k = 0; k < 6 && khung.parentElement; k++) khung = khung.parentElement;
            const nut = [...khung.querySelectorAll('*')].filter(x => x.getAttribute('title') || x.getAttribute('aria-label') || x.getAttribute('role') === 'button'
                || /icon|btn|button|download|fa-/i.test(x.getAttribute('class') || '') || x.tagName === 'BUTTON' || x.tagName === 'I' || x.tagName === 'svg');
            return `=== THẺ FILE ${i + 1} ===\nĐƯỜNG ĐI tới dòng dung lượng: ${duongDi(e)}\n--- khung 6 cấp trên ---\n${dump(khung, 14, 300, 3)}\n--- phần tử giống nút bấm trong khung ---\n${nut.slice(0, 30).map(moTa).join('\n')}`;
        }).join('\n\n') || '(không thấy thẻ file nào trong khung chat)';

        const anh = [...document.images].filter(i => i.naturalWidth >= 120 && i.getBoundingClientRect().left > 380).slice(-3);
        out.anh = anh.map((im, i) => {
            let khung = im;
            for (let k = 0; k < 5 && khung.parentElement; k++) khung = khung.parentElement;
            return `=== ẢNH ${i + 1} (${im.naturalWidth}x${im.naturalHeight}, src=${(im.getAttribute('src') || '').split(':')[0]}) ===\n${duongDi(im)}\n--- khung 5 cấp trên ---\n${dump(khung, 10, 120, 2)}`;
        }).join('\n\n') || '(không thấy ảnh lớn trong khung chat)';

        const ngay = [...document.querySelectorAll('*')].filter(e => laLa(e) && /^(?:\d{1,2}:\d{2}\s+)?(?:hôm nay|hôm qua|\d{1,2}\/\d{1,2}(?:\/\d{4})?|thứ .{1,4}(?:,)?\s*\d{1,2}\/\d{1,2}.*)$/i.test(e.textContent.trim()))
            .filter(e => e.getBoundingClientRect().left > 380).slice(-4);
        out.ngay = ngay.map(e => `${anChu(e.textContent)}  ←  ${duongDi(e)}`).join('\n') || '(không thấy thanh ngày)';
        return out;
    }
    return out;
}

// ───────────── chạy ─────────────
const ctx = await chromium.launchPersistentContext(path.resolve(__dirname, '../user_data'), {
    channel: process.env.BROWSER_CHANNEL || undefined,
    headless: false,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    acceptDownloads: false,
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1280,800']
});
const page = ctx.pages()[0] || await ctx.newPage();
log(`Đang mở https://chat.zalo.me (${process.env.BROWSER_CHANNEL || 'chromium'})...`);
await page.goto('https://chat.zalo.me', { waitUntil: 'domcontentloaded', timeout: 60000 });

const DANG_NHAP = '#main-tab, #chatView, .nav__tabs, div[data-translate-inner="STR_MENU_CHAT"], .left-sidebar-item, #conv-list';
let daVao = false;
for (let i = 0; i < 180; i++) {                                  // chờ tối đa 15 phút
    if (await page.$(DANG_NHAP)) { daVao = true; break; }
    if (i % 6 === 0) log(`CHƯA ĐĂNG NHẬP — quét mã QR trên cửa sổ trình duyệt (còn ~${Math.round((180 - i) * 5 / 60)} phút)`);
    await page.waitForTimeout(5000);
}
if (!daVao) { log('Hết giờ chờ đăng nhập — dừng'); await ctx.close(); process.exit(2); }
log('ĐÃ ĐĂNG NHẬP — chờ Zalo tải danh sách hội thoại');
await page.waitForTimeout(12000);

const tq = await page.evaluate(soiTrang, { viec: 'tong_quan' });
save('1_selector_cu.txt', tq.selectorCu);
save('2_khung_trang.txt', tq.khungTrang);
save('3_thanh_ben.txt', tq.thanhBen);
save('4_cloud_tren_thanh_ben.txt', tq.cloud);

const mo = await page.evaluate(soiTrang, { viec: 'mo_cloud' });
if (!mo.ok) {
    log('Không thấy "Cloud của tôi" ở thanh bên — chỉ soi được khung chung');
} else {
    log(`Đã mở "${mo.ten}" — chờ tin nhắn hiện ra`);
    await page.waitForTimeout(8000);
    const kc = await page.evaluate(soiTrang, { viec: 'khung_chat', tenChat: mo.ten });
    save('5_tieu_de_chat.txt', kc.tieuDe + '\n\n--- đầu khung chat ---\n' + kc.dauKhung);
    save('6_danh_sach_tin.txt', kc.dsTin);
    save('7_the_file.txt', kc.theFile);
    save('8_anh.txt', kc.anh);
    save('9_thanh_ngay.txt', kc.ngay);
}
await ctx.close();
log('XONG — đã đóng trình duyệt');
process.exit(0);
