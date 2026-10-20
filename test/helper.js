import fs from 'fs';
import os from 'os';
import path from 'path';

// Log của các module khi chạy test đi vào thư mục tạm, không lẫn vào logs/app.log thật.
// Phải import file này TRƯỚC các module trong src/.
if (!process.env.ZALOBOT_LOG_DIR) {
    process.env.ZALOBOT_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zalobot-log-'));
}

export function taoBoTest(tieuDe) {
    let passed = 0;
    let failed = 0;
    console.log(`\n🧪 ${tieuDe}`);
    return {
        test(name, result, expected) {
            const ok = JSON.stringify(result) === JSON.stringify(expected);
            if (ok) {
                passed++;
                console.log(`  ✅ ${name}`);
            } else {
                failed++;
                console.log(`  ❌ ${name} — Mong đợi: ${JSON.stringify(expected)}, Nhận được: ${JSON.stringify(result)}`);
            }
        },
        ketThuc() {
            console.log(`📊 ${passed} PASS / ${failed} FAIL`);
            if (failed) process.exit(1);
        }
    };
}
