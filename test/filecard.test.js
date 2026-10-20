import { taoBoTest } from './helper.js';
import { timTheFile, theTuDom } from '../src/filecard.js';

const { test, ketThuc } = taoBoTest('Nhận thẻ file Zalo (filecard.js) — mẫu lấy từ logs/app.log');

const a = timTheFile('Un\nit6.docx\n17.56 KB');
test('Tên tách đôi "Un" + "it6.docx"', a?.ten, 'Unit6.docx');
test('Đuôi file', a?.duoi, 'docx');
test('Dung lượng', a?.dungLuong, '17.56 KB');
test('Số byte', a?.soByte, Math.round(17.56 * 1024));

test('Tên có dấu cách', timTheFile('Screenshot 2026-03-06 20\n1501.png\n1.34 MB')?.ten, 'Screenshot 2026-03-06 201501.png');
test('PDF', timTheFile('dap_an_10_t\nphcm.pdf\n104.9 KB')?.ten, 'dap_an_10_tphcm.pdf');

const nhom = timTheFile('Cô Lan\nlich_thi_hoc_k\ny_1.xlsx\n20 KB\n08:15');
test('Trong nhóm: tên file', nhom?.ten, 'lich_thi_hoc_ky_1.xlsx');
test('Trong nhóm: dòng người gửi phía trên', nhom?.dongTruoc, ['Cô Lan']);

test('Tên ngắn một dòng', timTheFile('a.pdf\n10 KB')?.ten, 'a.pdf');
test('Tin thường có "MB" → không phải file', timTheFile('Anh gửi 2 MB nhé'), null);
test('Thiếu đuôi file → không phải file', timTheFile('Tài liệu\n12 KB'), null);
test('Rỗng', timTheFile(''), null);

// Thẻ đọc thẳng từ DOM (title của .file-message__content-title) — soi Zalo Web thật 01/10
const d = theTuDom({ ten: 'Lịch thi học kỳ 1 (bản cuối).pdf', dungLuong: '1,5 MB' });
test('DOM: tên đầy đủ có dấu, dấu cách, ngoặc', d?.ten, 'Lịch thi học kỳ 1 (bản cuối).pdf');
test('DOM: đuôi', d?.duoi, 'pdf');
test('DOM: dung lượng có dấu phẩy', [d?.dungLuong, d?.soByte], ['1,5 MB', Math.round(1.5 * 1048576)]);
test('DOM: thanh bên không có dung lượng', theTuDom({ ten: 'a.docx', dungLuong: '' }), { ten: 'a.docx', duoi: 'docx', dungLuong: '', soByte: 0, dongTruoc: [] });
test('DOM: không có đuôi → null', theTuDom({ ten: 'Tài liệu', dungLuong: '2 KB' }), null);

ketThuc();
