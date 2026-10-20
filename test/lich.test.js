// Kiểm thử lịch tự động + nhắc giờ: lich.js, reminders.js, autoplan.js (OpenRouter giả lập, Yuyuko giả).
// Chạy trong thư mục tạm, không đụng dữ liệu thật, không gọi mạng.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zalobot-lich-'));
process.env.ZALOBOT_DATA_DIR = path.join(tmp, 'data');
process.env.ZALOBOT_LOG_DIR = path.join(tmp, 'logs');
process.env.ZALOBOT_CONFIG = path.join(tmp, 'config.json');
process.env.YUYUKO_DIR = path.join(tmp, 'yuyuko');
fs.mkdirSync(process.env.YUYUKO_DIR);
delete process.env.OPENROUTER_API_KEY;
delete process.env.GLM_MODEL;

const realConfig = JSON.parse(fs.readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf-8'));
fs.writeFileSync(process.env.ZALOBOT_CONFIG, JSON.stringify({
    ...realConfig,
    autoSchedule: { ...(realConfig.autoSchedule || {}), enabled: true, model: 'z-ai/glm-5.3-flash', minConfidence: 0.6, scheduleFromText: true, conversationQuietSeconds: 1 },
    reminders: { enabled: false }
}, null, 2));

const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const vnDate = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const mai = new Date(Date.now() + 86400000);
const kia = new Date(Date.now() + 2 * 86400000);

// ---------- OpenRouter giả lập: trả lời theo khuôn JSON được yêu cầu ----------
const TEST_KEY = 'sk-or-v1-test-key-lich-0123456789';
const mockRequests = [];
const ev = (o) => ({ gio: '', gio_ket_thuc: '', dia_diem: '', ghi_chu: '', trich_dan: '', do_chac: 0.9, danh_cho_chu_nhan: true, ...o });
const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    mockRequests.push({ auth: req.headers.authorization, body });
    const schema = body.response_format?.json_schema?.name;
    const user = body.messages?.at(-1)?.content || '';
    let answer;
    if (Array.isArray(user)) {   // có ảnh gửi kèm (OCR không chạy → GLM đọc ảnh)
        answer = { tom_tat: 'Thông báo học bù', su_kien: [ev({ tieu_de: 'Học bù Vật lý', ngay: dayKey(kia), gio: '14:00', dia_diem: 'P.108' })] };
    } else if (schema === 'danh_gia_file') {
        answer = { doc_file: false, co_lich_trong_tin: false, ly_do: 'Không thấy dấu hiệu lịch' };
    } else if (user.includes('VIỆC BOT ĐÃ GHI') && user.includes('huỷ kèo')) {
        answer = { tom_tat: 'Huỷ hẹn', su_kien: [], cap_nhat: [{ ma: 'V1', hanh_dong: 'huy', ngay: '', gio: '', gio_ket_thuc: '', dia_diem: '', ly_do: 'Hùng bận đột xuất', trich_dan: 'Thôi huỷ kèo nha', do_chac: 0.9 }] };
    } else if (user.includes('VIỆC BOT ĐÃ GHI') && user.includes('dời sang 10h')) {
        answer = { tom_tat: 'Dời hẹn', su_kien: [], cap_nhat: [{ ma: 'V1', hanh_dong: 'doi', ngay: dayKey(kia), gio: '10:00', gio_ket_thuc: '', dia_diem: 'Highlands', ly_do: 'Hùng kẹt lúc 9h', trich_dan: 'dời sang 10h', do_chac: 0.9 }] };
    } else if (user.includes('ĐOẠN HỘI THOẠI') && user.includes('cà phê')) {
        answer = { tom_tat: 'Hẹn cà phê', su_kien: [ev({ tieu_de: 'Đi cà phê với Hùng', ngay: dayKey(kia), gio: '09:00', dia_diem: 'Highlands' })] };
    } else if (user.includes('=== DỮ LIỆU: FILE')) {
        answer = {
            tom_tat: 'Lịch thi học kỳ',
            su_kien: [
                ev({ tieu_de: 'Thi Toán', ngay: vnDate(mai), gio: '07:30', dia_diem: 'P.302', trich_dan: `Toán ${vnDate(mai)} 07:30` }),   // GLM hay trả dd/mm/yyyy
                ev({ tieu_de: 'Thi Văn', ngay: dayKey(kia), gio: '' }),
                ev({ tieu_de: 'Lớp 10A2 thi Anh', ngay: dayKey(kia), danh_cho_chu_nhan: false }),
                ev({ tieu_de: 'Có thể đi dã ngoại', ngay: dayKey(kia), do_chac: 0.3 }),
                ev({ tieu_de: 'Ngày ký văn bản', ngay: '2020-01-01' })
            ]
        };
    } else {
        answer = { tom_tat: 'Hẹn họp', su_kien: [ev({ tieu_de: 'Họp phụ huynh', ngay: dayKey(mai), gio: '08:00' })] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, provider: 'Giả', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 }, choices: [{ message: { content: JSON.stringify(answer) } }] }));
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

// Import sau khi đặt biến môi trường (module đọc biến môi trường lúc nạp)
const { chuanHoa, moTaDue, khoaTrung, parseNgay, giongViec } = await import('../src/lich.js');
const { tinhMocNhac, layNhacDenHan, loiNhac } = await import('../src/reminders.js');
const { xuLyFile, ghiNhanTin, cauHinhLich, _noiBo } = await import('../src/autoplan.js');
const { createTask, listTasks, updateTask } = await import('../src/tasks.js');
const { setSecret } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');

let passed = 0;
let failed = 0;
function test(name, result, expected) {
    const ok = JSON.stringify(result) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name} — Mong đợi: ${JSON.stringify(expected)}, Nhận được: ${JSON.stringify(result)}`); }
}
const section = (t) => console.log(`\n${t}`);
const notices = [];
bus.on('notice', n => notices.push(n));
const hopThu = () => {
    try { return fs.readFileSync(path.join(process.env.YUYUKO_DIR, 'yuyuko_hop_thu.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
    catch { return []; }
};
async function cho(dk, ms = 3000) {
    for (let t = 0; t < ms; t += 50) { if (dk()) return true; await new Promise(r => setTimeout(r, 50)); }
    return false;
}

console.log('🧪 Lịch tự động + nhắc giờ (lich.js, reminders.js, autoplan.js)');

section('📅 Chuẩn hoá việc GLM trả về (lich.js)');
const now = new Date();
test('ngày dd/mm/yyyy → hạn có giờ', chuanHoa(ev({ tieu_de: 'Họp', ngay: vnDate(mai), gio: '9:05' }), now).ev?.due, `${dayKey(mai)}T09:05`);
test('không giờ → hạn cả ngày', chuanHoa(ev({ tieu_de: 'Nộp bài', ngay: dayKey(mai) }), now).ev?.due, dayKey(mai));
test('giờ kết thúc bỏ khi không có giờ bắt đầu', chuanHoa(ev({ tieu_de: 'x', ngay: dayKey(mai), gio_ket_thuc: '10:00' }), now).ev?.gio_ket_thuc, '');
test('ngày đã qua → bỏ', !!chuanHoa(ev({ tieu_de: 'x', ngay: '2020-01-01' }), now).loi, true);
test('ngày không có thật (31/02) → bỏ', !!chuanHoa(ev({ tieu_de: 'x', ngay: `${now.getFullYear() + 1}-02-31` }), now).loi, true);
test('xa quá 400 ngày → bỏ', !!chuanHoa(ev({ tieu_de: 'x', ngay: `${now.getFullYear() + 3}-01-01` }), now).loi, true);
test('việc cả ngày hôm nay vẫn nhận', !!chuanHoa(ev({ tieu_de: 'x', ngay: dayKey(now) }), now).ev, true);
test('parseNgay 16.10.2026', parseNgay('16.10.2026'), [2026, 10, 16]);
test('mô tả mốc có giờ', moTaDue('2026-10-25T08:30'), '08:30 Chủ nhật 25/10/2026');
test('mô tả mốc cả ngày', moTaDue('2026-10-24'), 'cả ngày Thứ Bảy 24/10/2026');
test('khoá trùng bỏ dấu, hoa thường, dấu câu', khoaTrung('Họp  phụ-huynh!', '2026-10-25T08:00'), khoaTrung('hop phu huynh', '2026-10-25T08:00'));
const v = (title, due = '2026-10-24T14:00') => ({ title, due });
test('trùng: cùng giờ, tên gần giống (ảnh đọc 2 lần — đo thật 20/10)', giongViec(v('Học bù Vật lý lớp 12A'), v('Học bù Vật lý (phòng 108)')), true);
test('trùng: tên này chứa trọn tên kia', giongViec(v('Họp phụ huynh'), v('Họp phụ huynh học sinh lớp 12A')), true);
test('không trùng: "Thi Toán" / "Thi Văn" cùng giờ', giongViec(v('Thi Toán'), v('Thi Văn')), false);
test('không trùng: cùng tên khác giờ', giongViec(v('Họp tổ'), v('Họp tổ', '2026-10-25T14:00')), false);

const { dongTin } = await import('../src/planner.js');
const luc2210 = new Date(2026, 9, 20, 18, 10);
test('tin gửi hôm qua: ghi rõ ngày cạnh "mai" (tính theo ngày gửi)', dongTin({ sender: 'Trang', content: 'Mai 7h tối họp lớp', at: new Date(2026, 9, 19, 23, 30).getTime() }, luc2210),
    '[23:30 19/10 Thứ Hai, hôm qua] Trang: Mai [= 20/10/2026, Thứ Ba] 7h tối họp lớp');
test('tin gửi hôm nay: giữ nguyên, tên "Mai" không bị đụng', dongTin({ sender: 'Mai', content: 'Mai 8h họp nhé', at: new Date(2026, 9, 20, 9, 0).getTime() }, luc2210), '[09:00 20/10] Mai: Mai 8h họp nhé');

section('⏰ Mốc nhắc (reminders.js)');
const cfgNhac = { beforeMinutes: [1440, 60, 0], allDayEveningBefore: '20:00', allDayAt: '07:00' };
const moc = tinhMocNhac({ id: 't1', due: '2026-10-25T08:30' }, cfgNhac);
test('có giờ: 3 mốc', moc.map(m => m.nhan), ['còn 1 ngày', 'còn 1 tiếng', 'đến giờ']);
test('có giờ: mốc trước 1 tiếng', new Date(moc[1].luc).getHours(), 7);
const mocCaNgay = tinhMocNhac({ id: 't2', due: '2026-10-25' }, cfgNhac);
test('cả ngày: tối hôm trước 20:00 + sáng 07:00', mocCaNgay.map(m => `${new Date(m.luc).getDate()} ${new Date(m.luc).getHours()}h ${m.nhan}`), ['24 20h ngày mai', '25 7h hôm nay']);
test('không có hạn → không nhắc', tinhMocNhac({ id: 't3', due: null }, cfgNhac).length, 0);

const tLuc = (ms) => new Date(Date.now() + ms);
const hanTrong30p = tLuc(30 * 60000);
const dueOf = d => `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const cu = new Date(Date.now() - 3 * 86400000).toISOString();
const tasksNhac = [
    { id: 'a', title: 'Họp sớm', due: dueOf(hanTrong30p), status: 'todo', createdAt: cu, updatedAt: cu, source: { type: 'manual' } },
    { id: 'b', title: 'Việc vừa tạo', due: dueOf(hanTrong30p), status: 'todo', createdAt: new Date(Date.now() - 10 * 60000).toISOString(), source: { type: 'lich' } },
    { id: 'c', title: 'Đã xong', due: dueOf(hanTrong30p), status: 'done', createdAt: cu, source: { type: 'manual' } },
    { id: 'd', title: 'Xử lý tin khẩn', due: dueOf(hanTrong30p), status: 'todo', createdAt: cu, source: { type: 'alert' } }
];
const kqNhac = layNhacDenHan(tasksNhac, new Map(), new Date(), cfgNhac);
test('nhắc "còn 1 tiếng" của việc tạo từ lâu', kqNhac.canNhac.map(n => `${n.task.id}:${n.nhac.nhan}`), ['a:còn 1 tiếng']);
test('mốc "còn 1 ngày" trễ > 6 giờ → bỏ lỡ, không nhắc', kqNhac.boLo.map(n => `${n.task.id}:${n.nhac.nhan}`), ['a:còn 1 ngày']);
test('mốc đã nhắc rồi → không nhắc lại', layNhacDenHan(tasksNhac, new Map(kqNhac.canNhac.map(n => [n.nhac.khoa, 1])), new Date(), cfgNhac).canNhac.length, 0);
test('lời Yuyuko', loiNhac({ title: 'Thi Toán', due: '2026-10-25T07:30' }, 'còn 1 tiếng'), 'Chủ nhân ơi, còn 1 tiếng nữa là: Thi Toán (07:30 Chủ nhật 25/10/2026)!');

section('🗓️ Lên lịch từ file (autoplan.js + OpenRouter giả lập)');
setSecret('openrouterApiKey', TEST_KEY);
// Việc tạo tay sẵn — GLM tìm ra lại cùng việc này thì không được tạo trùng
createTask({ title: 'thi van', due: dayKey(kia) }, { type: 'manual' });

const fileTxt = path.join(tmp, 'lich_thi.txt');
fs.writeFileSync(fileTxt, `LỊCH THI HỌC KỲ\nToán ${vnDate(mai)} 07:30 P.302\nVăn ${dayKey(kia)}`);
const job = (o = {}) => ({ khoa: 'Lớp 12A', nguoiGui: 'Cô Lan', nhom: 'Lớp 12A', laNhom: true, file: { ten: 'lich_thi.txt', dungLuong: '1 KB' }, truoc: [], sau: [], duong: fileTxt, ...o });

const xem = await xuLyFile(job(), cauHinhLich(), { chiXem: true });
test('chế độ chỉ xem: có kết quả GLM', xem.kq?.su_kien?.length, 5);
test('chế độ chỉ xem: không tạo việc', listTasks().filter(t => t.source?.type === 'lich').length, 0);
const req0 = mockRequests.at(-1);
test('gửi đúng khoá của bot', req0.auth, `Bearer ${TEST_KEY}`);
test('dùng model lên lịch trong cấu hình', req0.body.model, 'z-ai/glm-5.3-flash');
test('bắt trả JSON theo khuôn', req0.body.response_format?.json_schema?.name, 'lich_tu_zalo');
test('nội dung file nằm trong khối DỮ LIỆU', req0.body.messages[1].content.includes(`Toán ${vnDate(mai)} 07:30`), true);

notices.length = 0;
const kqFile = await xuLyFile(job(), cauHinhLich());
const lich = listTasks().filter(t => t.source?.type === 'lich');
test('chỉ tạo việc chắc chắn, của Chủ nhân, chưa qua, chưa có', lich.map(t => `${t.title}|${t.due}`), [`Thi Toán|${dayKey(mai)}T07:30`]);
test('việc đã có (tạo tay, khác dấu) không bị tạo trùng', kqFile.loi.some(l => l.includes('Thi Văn') && l.includes('đã có')), true);
test('ghi chú có địa điểm + nguồn', /📍 P\.302/.test(lich[0]?.note) && /file "lich_thi\.txt" từ Cô Lan \(Lớp 12A\)/.test(lich[0]?.note), true);
test('nguồn công việc: lich + file + người gửi', [lich[0]?.source?.file, lich[0]?.source?.sender, lich[0]?.source?.kind], ['lich_thi.txt', 'Cô Lan', 'file']);
test('báo lên giao diện "Đã lên lịch"', notices.map(n => n.kind), ['scheduled']);
const thu = hopThu();
test('Yuyuko: thông báo + task một lần trong lịch', thu.map(x => x.loai), ['thong_bao', 'lich_moi']);
test('Yuyuko: lich_moi đúng ngày giờ', [thu[1]?.ngay, thu[1]?.gio, thu[1]?.phut], [dayKey(mai), 7, 30]);

await xuLyFile(job(), cauHinhLich());
test('đọc lại cùng file → không tạo trùng', listTasks().filter(t => t.source?.type === 'lich').length, 1);

section('🖼️ Ảnh khi OCR Trạm 1 không chạy → GLM đọc ảnh');
process.env.OCR_SERVER_URL = 'http://127.0.0.1:9/ocr';   // cổng không có gì → OCR lỗi ngay
const pngPath = path.join(tmp, 'thong_bao_hoc_bu.png');
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
fs.writeFileSync(pngPath, Buffer.from(PNG_1PX, 'base64'));
await xuLyFile(job({ file: { ten: 'thong_bao_hoc_bu.png', dungLuong: '' }, duong: pngPath }), cauHinhLich());
const reqAnh = mockRequests.at(-1).body;
const phanAnh = Array.isArray(reqAnh.messages[1].content) ? reqAnh.messages[1].content.find(p => p.type === 'image_url') : null;
test('file ảnh: gửi ảnh kèm câu hỏi (data:image/png)', !!phanAnh?.image_url?.url.startsWith('data:image/png;base64,'), true);
const viecAnh = listTasks().find(t => t.title === 'Học bù Vật lý');
test('file ảnh: tạo việc, nguồn là ảnh', [viecAnh?.due, viecAnh?.source?.kind], [`${dayKey(kia)}T14:00`, 'anh']);
const truocAnhChat = mockRequests.length;
const kqMeo = await xuLyFile(job({ laAnh: true, duong: null, file: { ten: 'ảnh', dungLuong: '' }, anh: [{ b64: PNG_1PX, mime: 'image/png' }],
    truoc: [{ sender: 'Hùng', content: 'haha dễ thương quá', at: Date.now() }] }), cauHinhLich());
test('ảnh trong chat, tin quanh ảnh không nhắc lịch → không gửi ảnh lên GLM', [mockRequests.length - truocAnhChat, kqMeo.lyDo], [0, 'ảnh không kèm dấu hiệu lịch']);
await xuLyFile(job({ laAnh: true, duong: null, file: { ten: 'ảnh', dungLuong: '' }, anh: [{ b64: PNG_1PX, mime: 'image/png' }],
    truoc: [{ sender: 'Lớp trưởng', content: 'Lịch học bù tuần này nha', at: Date.now() }] }), cauHinhLich());
test('ảnh trong chat + "lịch học bù" → gửi GLM; việc trùng tên gần giống không tạo lại', [mockRequests.length - truocAnhChat, listTasks().filter(t => t.title.startsWith('Học bù')).length], [1, 1]);

section('💬 Ghép lịch theo ĐOẠN HỘI THOẠI (ghiNhanTin)');
const nghi = ms => new Promise(r => setTimeout(r, ms));
const phutTruoc = n => Date.now() - n * 60000;
const tinHung = (o) => ghiNhanTin({ kind: 'conv', groupName: 'Hùng', sender: 'Hùng', nguoiGui: 'Hùng', ...o });
const tinToi = (o) => tinHung({ sender: 'Tôi (ở Hùng)', nguoiGui: 'Tôi', isSelf: true, ...o });
async function choHoiThoai(truoc) {
    await nghi(1200);
    _noiBo.chayViecDenHan();
    await cho(() => mockRequests.length > truoc);
    await nghi(300);
}

const truocHT = mockRequests.length;
tinHung({ content: 'Thứ 7 này rảnh không?', guiLuc: phutTruoc(4) });
tinToi({ content: 'Rảnh, đi đâu?', guiLuc: phutTruoc(3) });
tinHung({ content: 'Đi cà phê ở Highlands, 9h sáng nhé', guiLuc: phutTruoc(2) });
tinToi({ content: 'Ok', guiLuc: phutTruoc(1) });
_noiBo.chayViecDenHan();
test('hội thoại chưa ngớt → chưa gửi GLM', mockRequests.length, truocHT);
await choHoiThoai(truocHT);
test('hội thoại ngớt → MỘT lượt GLM cho cả đoạn', mockRequests.length - truocHT, 1);
const ndHT = mockRequests.at(-1).body.messages[1].content;
test('gửi cả 4 tin, kèm giờ gửi + người gửi ("Tôi" là Chủ nhân)',
    ['Hùng: Thứ 7 này rảnh không?', 'Tôi: Rảnh, đi đâu?', 'Hùng: Đi cà phê ở Highlands, 9h sáng nhé', 'Tôi: Ok'].every(x => ndHT.includes(x)) && /\[\d\d:\d\d \d\d\/\d\d\] Hùng: Thứ 7/.test(ndHT), true);
const cafe = listTasks().find(t => t.title === 'Đi cà phê với Hùng');
test('ghép manh mối rải rác thành một việc', cafe?.due, `${dayKey(kia)}T09:00`);
test('nguồn: đoạn chat', [cafe?.source?.chat, cafe?.source?.kind], ['Hùng', 'hoi_thoai']);

const truocOk = mockRequests.length;
tinToi({ content: 'Ok chốt nhé', guiLuc: phutTruoc(0) });
await choHoiThoai(truocOk);
test('"ok chốt" đến sau (trong 1 giờ từ manh mối) → xét lại; việc đã có không tạo trùng',
    [mockRequests.length - truocOk, listTasks().filter(t => t.title === 'Đi cà phê với Hùng').length], [1, 1]);

// Đổi giờ hẹn đã ghi
const truocDoi = mockRequests.length;
tinHung({ content: 'Ê dời sang 10h nha, 9h tao kẹt', guiLuc: phutTruoc(0) });
tinToi({ content: 'Ok', guiLuc: phutTruoc(0) });
await choHoiThoai(truocDoi);
const ndDoi = mockRequests.at(-1).body.messages[1].content;
test('gửi kèm việc đã ghi (mã V1) để GLM xét đổi / huỷ', /V1 \| Đi cà phê với Hùng \| 09:00 /.test(ndDoi), true);
const cafeDoi = listTasks().find(t => t.title === 'Đi cà phê với Hùng');
test('đổi giờ: sửa việc cũ, không tạo việc mới', [cafeDoi?.due, listTasks().filter(t => t.title.includes('cà phê')).length], [`${dayKey(kia)}T10:00`, 1]);
test('đổi giờ: ghi chú "Đổi lịch: cũ → mới"', /🔁 Đổi lịch lúc .*: 09:00 .* → 10:00 .* — Hùng kẹt lúc 9h/.test(cafeDoi?.note || ''), true);

// Huỷ — tin chỉ có "huỷ", không có ngày giờ
const truocHuy = mockRequests.length;
tinHung({ content: 'Thôi huỷ kèo nha, tao bận đột xuất', guiLuc: phutTruoc(0) });
await choHoiThoai(truocHuy);
test('"huỷ" không kèm ngày giờ vẫn được xét (đoạn chat có việc đã ghi)', mockRequests.length - truocHuy, 1);
const cafeHuy = listTasks().find(t => t.id === cafeDoi?.id);
test('huỷ: không xoá — đánh dấu xong + "❌ Huỷ:" + lý do', [cafeHuy?.status, cafeHuy?.title, /❌ Huỷ lúc .*Hùng bận đột xuất/.test(cafeHuy?.note || '')], ['done', '❌ Huỷ: Đi cà phê với Hùng', true]);
test('báo giao diện: đổi rồi huỷ, tên việc không bị lặp "❌ Huỷ:"', notices.filter(n => ['updated', 'cancelled'].includes(n.kind)).map(n => n.title),
    ['🔁 Đổi lịch: Đi cà phê với Hùng', '❌ Huỷ lịch: Đi cà phê với Hùng']);
test('Yuyuko được báo cả đổi lẫn huỷ', hopThu().filter(x => x.loai === 'thong_bao' && /đổi lịch|huỷ/.test(x.noi_dung)).length, 2);

const truocKhongViec = mockRequests.length;
ghiNhanTin({ kind: 'conv', sender: 'Z', groupName: 'Z', content: 'Thôi huỷ đi' });
await nghi(1200);
_noiBo.chayViecDenHan();
await nghi(300);
test('"huỷ" ở đoạn chat chưa có việc nào → không hỏi GLM', mockRequests.length, truocKhongViec);

// Việc AI phân tích tin (ai.js) đã tạo từ tin lẻ: cùng đoạn chat + cùng giờ, tên khác hẳn
createTask({ title: 'Họp PH', due: `${dayKey(mai)}T08:00` }, { type: 'zalo', sender: 'Sếp', content: 'Mai 8h họp phụ huynh nhé' });
const soViecSep = listTasks().length;
const truocSep = mockRequests.length;
ghiNhanTin({ kind: 'conv', sender: 'Sếp', groupName: 'Sếp', nguoiGui: 'Sếp', content: 'Mai 8h họp phụ huynh nhé', guiLuc: phutTruoc(0) });
await choHoiThoai(truocSep);
test('việc AI phân tích tin đã tạo (cùng đoạn chat + cùng giờ) → không tạo trùng', [mockRequests.length - truocSep, listTasks().length], [1, soViecSep]);

const truocTat = mockRequests.length;
ghiNhanTin({ kind: 'conv', sender: 'X', groupName: 'X', content: 'Chào buổi sáng cả nhà' });
ghiNhanTin({ kind: 'conv', sender: 'X', groupName: 'X', content: 'ok' });
ghiNhanTin({ kind: 'conv', sender: 'Y', groupName: 'Y', content: 'Mai 9h đi khám', isTest: true });
await nghi(1200);
_noiBo.chayViecDenHan();
await nghi(300);
test('không manh mối / "ok" đứng lẻ / tin thử → không hỏi GLM', mockRequests.length, truocTat);

section('🖱️ Nút tải file khi không có trang Zalo');
test('chưa gắn trang → không bấm, không lỗi', await _noiBo.taiTuDong({ ten: 'a.pdf' }), false);

// Việc đã xong không còn được nhắc
const hop = listTasks().find(t => t.source?.type === 'lich' && t.status !== 'done');
updateTask(hop.id, { status: 'done' });
test('việc đã xong → không có mốc nhắc đến hạn', layNhacDenHan([listTasks().find(t => t.id === hop.id)], new Map(), new Date(Date.now() + 2 * 86400000), cfgNhac).canNhac.length, 0);

mock.close();
console.log(`\n📊 ${passed} PASS / ${failed} FAIL`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
