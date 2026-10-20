import { taoBoTest } from './helper.js';
import { timMocThoiGian, nenGuiGLM, trichDoan } from '../src/dates.js';

const { test, ketThuc } = taoBoTest('Dò mốc ngày giờ (dates.js)');
const tin = (s) => nenGuiGLM(timMocThoiGian(s), false);
const file = (s) => nenGuiGLM(timMocThoiGian(s), true);

// Ngày rõ ràng
test('dd/mm/yyyy', timMocThoiGian('Họp ngày 11/10/2026').ngayRo, true);
test('dd-mm', timMocThoiGian('hạn 15-10').ngayRo, true);
test('dd.mm.yyyy', timMocThoiGian('Hạn nộp: 15.10.2026').ngayRo, true);
test('ISO yyyy-mm-dd', timMocThoiGian('deadline 2026-10-15').ngayRo, true);
test('"15 tháng 10"', timMocThoiGian('Khai giảng 15 tháng 10').ngayRo, true);
test('không dấu "ngay 11"', timMocThoiGian('hop ngay 11 nhe').ngayRo, true);
test('99/99 không phải ngày', timMocThoiGian('mã 99/99').ngayRo, false);

// Ngày mơ hồ
test('"Thứ Bảy"', timMocThoiGian('sáng Thứ Bảy').ngayMo, true);
test('"thu 7" không dấu', timMocThoiGian('thu 7 di hoc').ngayMo, true);
test('"Chủ nhật"', timMocThoiGian('Chủ nhật này').ngayMo, true);
test('"thứ tự" KHÔNG phải thứ trong tuần', timMocThoiGian('xếp theo thứ tự bảng chữ cái').ngayMo, false);
test('"sáng mai"', timMocThoiGian('sáng mai nộp bài').ngayMo, true);
test('"tuần sau"', timMocThoiGian('tuần sau kiểm tra').ngayMo, true);

// Giờ
test('"8h30"', timMocThoiGian('8h30 họp').gio, true);
test('"14:00"', timMocThoiGian('lúc 14:00').gio, true);
test('"8 giờ 30 phút"', timMocThoiGian('vào 8 giờ 30 phút').gio, true);
test('"25:00" không phải giờ', timMocThoiGian('tỉ số 25:00').gio, false);

// Hạn chót / lịch
test('"hạn nộp"', timMocThoiGian('Hạn nộp hồ sơ').han, true);
test('"lich thi" không dấu', timMocThoiGian('gui lich thi hoc ky').han, true);

// Có đáng gửi GLM không — tin nhắn chữ
test('Tin: "mai 8h họp nhé" → gửi', tin('mai 8h họp nhé'), true);
test('Tin: "tối nay 8h nhậu" → gửi', tin('tối nay 8h nhậu'), true);
test('Tin: "Hạn nộp 20/10" → gửi', tin('Hạn nộp 20/10'), true);
test('Tin: "hôm nay mệt quá" → KHÔNG', tin('hôm nay mệt quá'), false);
test('Tin: "ok anh" → KHÔNG', tin('ok anh'), false);
test('Tin: chỉ có giờ "18:42" → KHÔNG', tin('18:42'), false);
test('Tin: "xem lịch thi nhé" (không ngày giờ) → KHÔNG', tin('Cả lớp xem lịch họp phụ huynh và lịch thi nhé'), false);
test('Tin: "lịch thi thứ 5" → gửi', tin('lịch thi thứ 5 nhé'), true);

// File
test('File có ngày → đọc cả file', file('THONG BAO LICH HOP PHU HUYNH\nThoi gian: 8h30 sang Thu Bay, ngay 11/10/2026'), true);
test('File chỉ có "thứ Tư" → để GLM xét tên + tin kèm', file('Chiều thứ Tư sinh hoạt lớp'), false);
test('File không có mốc → KHÔNG', file('Biên bản vui chơi tập thể'), false);

// Trích đoạn quanh mốc
const s = 'Mở đầu dài dòng. '.repeat(30) + 'Hạn nộp học phí: 15/10/2026. ' + 'Kết thúc. '.repeat(30);
const doan = trichDoan(s, timMocThoiGian(s).hits, 40);
test('Trích đoạn có chứa mốc', doan.includes('15/10/2026'), true);
test('Trích đoạn ngắn hơn cả văn bản', doan.length < s.length / 3, true);

ketThuc();
