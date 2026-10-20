import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { taoBoTest } from './helper.js';

/**
 * Chạy listener + nút tải file + lấy ảnh trên test/zalo_mau.html (khung dựng theo lần soi
 * Zalo Web thật 01/10/2026) trong trình duyệt ẩn. Không đụng tới Zalo thật.
 */

// Thư mục dữ liệu tạm — phải đặt TRƯỚC khi nạp src/autoplan.js (schedule.js đọc lúc nạp)
process.env.ZALOBOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zalobot-data-'));
const { startMessageListener } = await import('../src/listener.js');
const { ganTrang, _noiBo } = await import('../src/autoplan.js');
const { chromium } = createRequire(import.meta.url)('playwright');

const { test, ketThuc } = taoBoTest('Listener trên trang mẫu theo DOM Zalo Web thật (listener.js, autoplan.js)');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nghi = ms => new Promise(r => setTimeout(r, ms));

let browser = null;
for (const channel of [...new Set([process.env.BROWSER_CHANNEL, undefined, 'msedge'])]) {
    try {
        browser = await chromium.launch({ channel, headless: true });
        break;
    } catch (e) { /* thử kênh khác */ }
}
if (!browser) {
    console.log('  ⏭️  Không mở được trình duyệt (chưa có Chromium/Edge) — bỏ qua test này');
    process.exit(0);
}

try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(pathToFileURL(path.join(__dirname, 'zalo_mau.html')).href);
    await page.waitForFunction(() => window.__sanSang === true);

    const nhan = [];
    await startMessageListener(page, (msg) => { nhan.push(msg); });   // chờ trang "yên" ≥ 5 giây mới sẵn sàng
    test('Lúc bắt đầu: tin có sẵn và thanh bên chỉ vào bộ nhớ đệm', nhan.length, 0);

    // Lấy tin mới phát sinh sau một thao tác
    async function sau(thaoTac, cho = 300) {
        const truoc = nhan.length;
        await thaoTac();
        await nghi(cho);
        return nhan.slice(truoc);
    }

    // --- Khung chat (đang mở "Lớp 12A") ---
    let m = await sau(() => page.evaluate(() => themTin({ ten: 'Cô Lan', chu: 'Mai 8h họp phụ huynh' })));
    test('Tin mới trong nhóm: 1 tin', m.length, 1);
    test('Tin mới trong nhóm: nội dung sạch (không giờ gửi, "Đã gửi", cảm xúc)', m[0]?.content, 'Mai 8h họp phụ huynh');
    test('Tin mới trong nhóm: sender = tên đoạn chat (header-title)', m[0]?.sender, 'Lớp 12A');
    test('Tin mới trong nhóm: người gửi thật', m[0]?.nguoiGui, 'Cô Lan');
    test('Tin mới trong nhóm: là nhóm (ảnh đại diện ghép ở thanh bên)', [m[0]?.isGroup, m[0]?.isSelf, m[0]?.kind], [true, false, 'chat']);
    test('Tin mới trong nhóm: có mã tin', /^bb_msg_id_\d+$/.test(m[0]?.msgId || ''), true);

    m = await sau(() => page.evaluate(() => themTin({ chu: 'Nhớ mang sổ liên lạc' })));
    test('Tin nối tiếp không ghi tên → lần ngược ra người gửi', m[0]?.nguoiGui, 'Cô Lan');

    m = await sau(() => page.evaluate(() => themTin({ me: true, chu: 'Dạ em nhận' })));
    test('Tin của mình: isSelf + sender "Tôi (ở …)"', [m[0]?.isSelf, m[0]?.sender, m[0]?.nguoiGui], [true, 'Tôi (ở Lớp 12A)', 'Tôi']);

    m = await sau(() => page.evaluate(() => themTin({ chu: 'Em hỏi cô ạ' })));
    test('Sau tin của mình, tin không tên không gán nhầm cho Cô Lan', m[0]?.nguoiGui, '');

    const TEN_FILE = 'Lịch thi học kỳ 1 (bản cuối).pdf';
    m = await sau(() => page.evaluate((ten) => themTin({ ten: 'Cô Lan', file: { ten, size: '1.2 MB' } }), TEN_FILE));
    test('Thẻ file: tên đầy đủ từ thuộc tính title + dung lượng', m[0]?.file, { ten: TEN_FILE, dungLuong: '1.2 MB' });
    test('Thẻ file: nội dung không lẫn "Đã có trên Cloud" / "Nhấn để xem trước"', m[0]?.content, `${TEN_FILE}\n1.2 MB`);

    let idAnh = '';
    m = await sau(async () => { idAnh = await page.evaluate(() => themTin({ ten: 'Hùng', anh: 1 })); });
    test('Tin ảnh: không có chữ vẫn báo "[Hình ảnh]" kèm số ảnh', [m[0]?.content, m[0]?.soAnh, m[0]?.msgId], ['[Hình ảnh]', 1, idAnh]);

    m = await sau(() => page.evaluate(() => themTin({ ten: 'Cô Lan', chu: 'Tin chèn vào khối hôm qua' }, 0)));
    test('Tin nằm dưới thanh ngày cũ (30/09) → không báo', m.length, 0);

    m = await sau(() => page.evaluate(() => {
        const d = new Date(Date.now() - 3 * 3600000);
        return themTin({ ten: 'Cô Lan', chu: 'Tin cũ Zalo render lại', gio: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` });
    }));
    test('Giờ gửi đã qua 3 tiếng (dù dưới "Hôm nay") → không báo', m.length, 0);

    m = await sau(() => page.evaluate(() => thaTim()));
    test('Thả cảm xúc vào tin cũ → không báo', m.length, 0);

    m = await sau(async () => {
        await page.evaluate(() => themTin({ ten: 'Cô Lan', chu: 'ok' }));
        await page.evaluate(() => themTin({ chu: 'ok' }));
    });
    test('Hai tin "ok" giống hệt → vẫn là hai tin (khác mã tin)', m.length, 2);

    m = await sau(() => page.evaluate(() => themNhieuTin(8)));
    test('8 tin cùng lúc (Zalo render lịch sử) → không báo', m.length, 0);

    m = await sau(() => page.evaluate(() => themTin({ ten: 'Cô Lan', chu: 'Tin gửi 2 tiếng trước, Zalo render lại', guiLuc: Date.now() - 2 * 3600000 })));
    test('Giờ gửi thật (id / dữ liệu tin) đã qua 2 tiếng → không báo, dù nằm cuối và dưới "Hôm nay"', m.length, 0);

    m = await sau(() => page.evaluate(async () => {
        await themTin({ me: true, chu: 'Em hỏi thêm' });
        return themTin({ ten: '', dName: 'Thầy Bình', chu: 'Thầy trả lời nhé' });
    }));
    test('Tên người gửi lấy từ dữ liệu tin (dName) khi Zalo không hiện khối tên', m.map(x => x.nguoiGui).at(-1), 'Thầy Bình');
    test('Tin có giờ gửi thật', m.every(x => x.guiLuc > Date.now() - 60000), true);

    m = await sau(() => page.evaluate(() => chenTinPhiaTren(3)), 500);
    test('Cuộn lên: Zalo chèn từng tin cũ của hôm nay lên TRÊN tin đang có → không báo', m.length, 0);

    m = await sau(() => page.evaluate(() => themTin({ ten: 'Cô Lan', chu: 'Tin mới thật sau khi cuộn' })));
    test('Sau khi cuộn lên, tin mới thật (nối vào cuối) vẫn báo', m.map(x => x.content), ['Tin mới thật sau khi cuộn']);

    // --- Thanh bên: React đổi chữ trong dòng có sẵn ---
    m = await sau(() => page.evaluate(() => doiXemTruoc('Mẹ', { chu: 'Con ơi về nhà gấp' })), 900);
    test('Thanh bên: tin mới ở chat 1-1 đang đóng', m.map(x => [x.sender, x.nguoiGui, x.content, x.isGroup, x.kind]), [['Mẹ', 'Mẹ', 'Con ơi về nhà gấp', false, 'conv']]);

    m = await sau(() => page.evaluate(() => doiXemTruoc('Nhóm Dự án', { nguoi: 'Hùng', chu: 'Deadline thứ 6 tuần sau' })), 900);
    test('Thanh bên: nhóm (có tên người gửi) → isGroup + người gửi thật', m.map(x => [x.sender, x.nguoiGui, x.content, x.isGroup]), [['Nhóm Dự án', 'Hùng', 'Deadline thứ 6 tuần sau', true]]);

    m = await sau(() => page.evaluate(() => doiXemTruoc('Lớp 12A', { nguoi: 'Cô Lan', chu: 'Tin này khung chat đã báo' })), 900);
    test('Thanh bên: đoạn chat đang mở → không báo trùng', m.length, 0);

    m = await sau(() => page.evaluate(() => doiXemTruoc('Mẹ', { nguoi: 'Bạn', chu: 'Dạ con về liền' })), 900);
    test('Thanh bên: "Bạn: …" là tin của mình', m.map(x => [x.isSelf, x.sender, x.content]), [[true, 'Tôi (ở Mẹ)', 'Dạ con về liền']]);

    m = await sau(() => page.evaluate(() => doiXemTruoc('Nhóm Dự án', { nguoi: 'Hùng', chu: 'Tin cũ cuộn tới', khoaGio: 'STR_DAY', soGio: '2' })), 900);
    test('Thanh bên: nhãn giờ "2 ngày" → không báo', m.length, 0);

    m = await sau(() => page.evaluate(() => doiXemTruoc('Mẹ', { nguoi: '', chu: 'Mẹ nhắn 2 phút trước', khoaGio: 'STR_MINS', soGio: '2' })), 900);
    test('Thanh bên: nhãn "2 phút" vẫn tính là mới', m.length, 1);

    m = await sau(() => page.evaluate(() => doiXemTruoc('Mẹ', { nguoi: '', chu: 'Mẹ nhắn 5 phút trước', khoaGio: 'STR_MINS', soGio: '5' })), 900);
    test('Thanh bên: nhãn "5 phút" → tin cũ render lại, không báo', m.length, 0);

    // Nhiều bên cùng nhắn một lúc: 3 dòng thanh bên đổi trong cùng một lượt quét + khung chat đang mở có tin
    m = await sau(() => page.evaluate(async () => {
        doiXemTruoc('Mẹ', { nguoi: '', chu: 'Mẹ nhắn cùng lúc' });
        doiXemTruoc('Nhóm Dự án', { nguoi: 'Hùng', chu: 'Hùng nhắn cùng lúc' });
        doiXemTruoc('Chị Hoa', { chu: 'Chị Hoa nhắn cùng lúc' });
        await themTin({ ten: 'Cô Lan', chu: 'Cô Lan nhắn cùng lúc' });
    }), 900);
    test('Nhiều bên nhắn cùng lúc → đủ 4 tin, đúng người gửi, mỗi tin một lần',
        m.map(x => `${x.kind}|${x.nguoiGui}|${x.content}`).sort(),
        ['chat|Cô Lan|Cô Lan nhắn cùng lúc', 'conv|Chị Hoa|Chị Hoa nhắn cùng lúc', 'conv|Hùng|Hùng nhắn cùng lúc', 'conv|Mẹ|Mẹ nhắn cùng lúc']);

    // Chat với chính mình: Chủ nhân đặt VIP "My Documents" để tự báo động từ điện thoại
    m = await sau(() => page.evaluate(() => doiXemTruoc('My Documents', { nguoi: 'Bạn', chu: 'Báo động thử từ điện thoại' })), 900);
    test('Thanh bên My Documents: "Bạn: …" vẫn báo, sender = My Documents (để khớp VIP)', m.map(x => [x.sender, x.isSelf, x.nguoiGui, x.isGroup]), [['My Documents', false, 'Tôi', false]]);

    // --- Nút tải file + lấy ảnh (autoplan.js) ---
    ganTrang(page);
    const taiDuoc = await _noiBo.taiTuDong({ ten: TEN_FILE });
    test('Tải file: bấm được nút "Lưu về máy" (ẩn tới khi rê chuột) và file về máy', taiDuoc, true);
    const daLuu = fs.readdirSync(path.join(process.env.ZALOBOT_DATA_DIR, 'files'), { recursive: true }).some(f => String(f).endsWith('Lịch thi học kỳ 1 (bản cuối).pdf'));
    test('Tải file: lưu trong data/files/<ngày>/', daLuu, true);
    test('Tải file: thẻ không có trong khung chat → false', await _noiBo.taiTuDong({ ten: 'khong_co.pdf' }), false);

    const anh = await _noiBo.layAnhTrongTin(idAnh);
    test('Lấy ảnh blob: 1 ảnh PNG', [anh.length, anh[0]?.mime, Buffer.from(anh[0]?.b64 || '', 'base64').subarray(1, 4).toString()], [1, 'image/png', 'PNG']);

    // --- Đổi đoạn chat: lịch sử render lại không bị coi là tin mới ---
    m = await sau(() => page.evaluate(() => doiDoanChat('Mẹ')), 600);
    test('Đổi sang đoạn chat khác → lịch sử không báo', m.length, 0);

    m = await sau(() => page.evaluate(() => doiDoanChat('My Documents')), 600);
    test('Mở My Documents → lịch sử không báo', m.length, 0);
    await nghi(2600);   // hết khoảng "vừa đổi đoạn chat"
    m = await sau(() => page.evaluate(() => themTin({ me: true, chu: 'Mai 9h khám răng' }, 0)));
    test('Khung chat My Documents: tin của mình không bị coi là "tin của tôi"', m.map(x => [x.sender, x.isSelf, x.nguoiGui, x.isGroup]), [['My Documents', false, 'Tôi', false]]);
} finally {
    await browser.close();
}

ketThuc();
