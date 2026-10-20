// Thử hộp thư Yuyuko: mở Yuyuko (shimeji.exe bản mới) rồi chạy lệnh này — trong ~2 giây Yuyuko kêu
// và hiện bong bóng.
//   node tools/thu_yuyuko.js          → một câu nhắc + một thông báo
//   node tools/thu_yuyuko.js --task   → thêm cả task "[Thử] Việc từ Zalo" vào lịch Yuyuko ngày mai
import 'dotenv/config';
import { guiYuyuko } from '../src/yuyuko.js';

const pad = n => String(n).padStart(2, '0');
const mai = new Date(Date.now() + 86400000);
const ngayMai = `${mai.getFullYear()}-${pad(mai.getMonth() + 1)}-${pad(mai.getDate())}`;

const ok = guiYuyuko('nhac', { noi_dung: 'Chủ nhân ơi, đây là câu nhắc THỬ từ bot Zalo!' })
    && guiYuyuko('thong_bao', { noi_dung: 'Hộp thư Zalo → Yuyuko chạy tốt rồi nha.' })
    && (!process.argv.includes('--task') || guiYuyuko('lich_moi', { tieu_de: '[Thử] Việc từ Zalo', ghi_chu: 'Xoá được trong tab lịch', ngay: ngayMai, gio: 9, phut: 0 }));

console.log(ok
    ? `Đã ghi vào ${process.env.YUYUKO_DIR}\\yuyuko_hop_thu.jsonl — nhìn Yuyuko nhé.`
    : 'Không ghi được — kiểm tra YUYUKO_DIR trong .env');
process.exit(ok ? 0 : 1);
