import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { taoBoTest } from './helper.js';
import { docFile } from '../src/docs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { test, ketThuc } = taoBoTest('Đọc file bằng code (docs.js + tools/doc_text.py)');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zalobot-mau-'));
execFileSync(process.env.PYTHON || 'python', [path.join(__dirname, 'tao_mau.py'), dir], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
const f = name => path.join(dir, name);

const docx = await docFile(f('lich_hop.docx'));
test('DOCX đọc được', docx.ok, true);
test('DOCX có đoạn văn', docx.text.includes('ngày 10/10/2026'), true);
test('DOCX có bảng theo hàng', docx.text.includes('Toán | 12/10/2026 | 07:30'), true);

const xlsx = await docFile(f('lich_thi.xlsx'));
test('XLSX: ô datetime thành dd/mm/yyyy HH:MM', xlsx.text.includes('Toán | 12/10/2026 07:30 | P.302'), true);
test('XLSX: ô date thành dd/mm/yyyy', xlsx.text.includes('Văn | 13/10/2026 | P.301'), true);

const pptx = await docFile(f('ke_hoach.pptx'));
test('PPTX: đúng thứ tự trang chiếu', pptx.text.indexOf('Kế hoạch tháng 10') < pptx.text.indexOf('Hạn nộp báo cáo: 20/10/2026'), true);

const pdf = await docFile(f('thong_bao.pdf'));
test('PDF có lớp chữ', pdf.text.includes('14/10/2026'), true);
test('PDF: số trang', pdf.soTrang, 1);

const txt = await docFile(f('ghi_chu.txt'));
test('TXT tiếng Việt', txt.text, 'Nộp báo cáo quý trước 20/10/2026');

test('EXE: không đọc', (await docFile(f('virus.exe'))).ok, false);
test('Quá giới hạn dung lượng: không đọc', (await docFile(f('lich_hop.docx'), { maxMB: 0.0001 })).ok, false);

// Đường OCR cần máy chủ Trạm 1 — không với tới thì bỏ qua (không tính là lỗi)
let coOcr = false;
try {
    // Có trả lời (kể cả 405 vì không nhận GET) = máy chủ sống
    await fetch(process.env.OCR_SERVER_URL || 'http://127.0.0.1:5000/ocr', { signal: AbortSignal.timeout(3000) });
    coOcr = true;
} catch (e) {
    coOcr = false;
}
if (coOcr) {
    const anh = await docFile(f('anh_lich.png'));
    test('Ảnh PNG qua OCR có ngày', anh.text.includes('15/10/2026'), true);
    const scan = await docFile(f('scan.pdf'));
    test('PDF quét → OCR ảnh nhúng có ngày', scan.text.includes('15/10/2026'), true);
    test('PDF quét: ghi chú số trang không có chữ', /không có lớp chữ/.test(scan.ghiChu), true);
} else {
    console.log('  ⏭️  Không với tới máy chủ OCR — bỏ qua phần ảnh / PDF quét');
}

fs.rmSync(dir, { recursive: true, force: true });
ketThuc();
