// Thử quy trình lên lịch trên MỘT file trong máy, không cần mở Zalo:
//   node tools/thu_lich.js <file> [--nguoi "Cô chủ nhiệm"] [--nhom "Lớp 10A1"] [--truoc "tin trước"] [--sau "tin sau"] [--luu]
// Mặc định chỉ in kết quả GLM (không tạo công việc, không báo giao diện/Yuyuko). Thêm --luu để lên lịch thật.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { xuLyFile, cauHinhLich } from '../src/autoplan.js';

const args = process.argv.slice(2);
const opt = { nguoi: [], nhom: [], truoc: [], sau: [] };
let file = null;
let luu = false;
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--luu') luu = true;
    else if (a.startsWith('--') && opt[a.slice(2)]) opt[a.slice(2)].push(args[++i] ?? '');
    else if (!file) file = a;
}

if (!file || !fs.existsSync(file)) {
    console.log('Dùng: node tools/thu_lich.js <file> [--nguoi "tên"] [--nhom "nhóm"] [--truoc "tin"] [--sau "tin"] [--luu]');
    process.exit(1);
}

const nguoiGui = opt.nguoi[0] || 'Người gửi thử';
const nhom = opt.nhom[0] || '';
const tin = (content) => ({ sender: nguoiGui, content, at: Date.now() });
const job = {
    khoa: 'thu', nguoiGui, nhom, laNhom: !!nhom,
    file: { ten: path.basename(file), dungLuong: `${(fs.statSync(file).size / 1024).toFixed(1)} KB` },
    truoc: opt.truoc.map(tin),
    sau: opt.sau.map(tin),
    duong: path.resolve(file)
};

const kq = await xuLyFile(job, cauHinhLich(), { chiXem: !luu });
console.log('\n===== KẾT QUẢ =====');
console.log(JSON.stringify(kq, null, 2));
process.exit(0);
