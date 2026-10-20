import { evaluateMessage } from '../src/filter.js';

console.log('🧪 Bắt đầu kiểm thử toàn diện bộ lọc tin nhắn...\n');

let passed = 0;
let failed = 0;

function test(name, result, expected) {
    const ok = result === expected;
    if (ok) {
        passed++;
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        console.log(`  ❌ ${name} — Mong đợi: ${expected}, Nhận được: ${result}`);
    }
}

// ═══════════════════════════════════════════════════
// NHÓM 1: Tin nhắn bình thường → KHÔNG gọi
// ═══════════════════════════════════════════════════
console.log('\n📋 NHÓM 1: Tin nhắn bình thường');

test('Tin bình thường', evaluateMessage({
    sender: 'Bạn A', content: 'Mai đi ăn trưa không mày?', isGroup: false
}).shouldCall, false);

test('Tin chào hỏi', evaluateMessage({
    sender: 'Bạn B', content: 'Hello, dạo này thế nào?', isGroup: false
}).shouldCall, false);

// ═══════════════════════════════════════════════════
// NHÓM 2: Từ khóa khẩn cấp → PHẢI gọi
// ═══════════════════════════════════════════════════
console.log('\n🚨 NHÓM 2: Từ khóa khẩn cấp');

test('Chứa "sập server"', evaluateMessage({
    sender: 'Bạn B', content: 'Alo gấp có sự cố sập server rồi ông ơi!', isGroup: false
}).shouldCall, true);

test('Chứa "lỗi"', evaluateMessage({
    sender: 'Dev Team', content: 'Hệ thống đang bị lỗi nghiêm trọng', isGroup: false
}).shouldCall, true);

// ═══════════════════════════════════════════════════
// NHÓM 3: Người gửi VIP → PHẢI gọi
// ═══════════════════════════════════════════════════
console.log('\n👑 NHÓM 3: Người gửi VIP');

test('VIP "Sếp" nhắn', evaluateMessage({
    sender: 'Sếp', content: 'Em gửi anh báo cáo nhé', isGroup: false
}).shouldCall, true);

// ═══════════════════════════════════════════════════
// NHÓM 4: Cooldown chống spam
// ═══════════════════════════════════════════════════
console.log('\n⏳ NHÓM 4: Cooldown chống spam');

const test4 = evaluateMessage({
    sender: 'Sếp', content: 'Báo cáo gấp!', isGroup: false
});
test('Cooldown hoạt động', test4.shouldCall === false && test4.isCoolingDown === true, true);

// ═══════════════════════════════════════════════════
// NHÓM 5: [FIX] Lọc nhãn ngày tháng Zalo — KHÔNG gọi
// ═══════════════════════════════════════════════════
console.log('\n📅 NHÓM 5: Nhãn ngày tháng Zalo (phải bỏ qua)');

test('"Hôm qua" (nhãn ngày)', evaluateMessage({
    sender: 'Zalo', content: 'Hôm qua', isGroup: false
}).shouldCall, false);

test('"15/07" (nhãn ngày)', evaluateMessage({
    sender: 'Zalo', content: '15/07', isGroup: false
}).shouldCall, false);

test('"15/07/2026" (nhãn ngày)', evaluateMessage({
    sender: 'Zalo', content: '15/07/2026', isGroup: false
}).shouldCall, false);

test('"2 ngày trước" (nhãn ngày)', evaluateMessage({
    sender: 'Zalo', content: '2 ngày trước', isGroup: false
}).shouldCall, false);

test('"Thứ Hai" (nhãn ngày)', evaluateMessage({
    sender: 'Zalo', content: 'Thứ Hai', isGroup: false
}).shouldCall, false);

// ═══════════════════════════════════════════════════
// NHÓM 6: [FIX] Tin nhắn chứa số có dạng dd/mm NHƯNG LÀ NỘI DUNG THỰC — PHẢI GỌI NẾU CÓ TỪ KHÓA
// ═══════════════════════════════════════════════════
console.log('\n🔧 NHÓM 6: [FIX] Tin nhắn chat chứa dd/mm → KHÔNG bị lọc nhầm');

test('"Lỗi từ 15/08 đến nay" phải được xử lý', evaluateMessage({
    sender: 'Dev', content: 'Lỗi từ 15/08 đến nay chưa fix', isGroup: false
}).shouldCall, true);  // Chứa "lỗi" → phải gọi, KHÔNG bị bỏ qua vì 15/08

test('"Bán 2/3 lô hàng" phải KHÔNG gọi (không có từ khóa)', evaluateMessage({
    sender: 'Bạn C', content: 'Bán 2/3 lô hàng cho khách nhé', isGroup: false
}).shouldCall, false);

test('"Server sập lúc 3/8" phải GỌI (có từ khóa "sập")', evaluateMessage({
    sender: 'Admin', content: 'Server sập lúc 3/8 cần fix gấp', isGroup: false
}).shouldCall, true);

// ═══════════════════════════════════════════════════
// NHÓM 7: Tin nhắn rỗng/đặc biệt → KHÔNG gọi
// ═══════════════════════════════════════════════════
console.log('\n🚫 NHÓM 7: Nội dung đặc biệt');

test('Nội dung rỗng', evaluateMessage({
    sender: 'Ai đó', content: '', isGroup: false
}).shouldCall, false);

test('Nội dung null', evaluateMessage({
    sender: 'Ai đó', content: null, isGroup: false
}).shouldCall, false);

// ═══════════════════════════════════════════════════
// NHÓM 8: [FIX] Từ thường gần giống từ khóa → KHÔNG gọi nhầm
// ═══════════════════════════════════════════════════
console.log('\n🎯 NHÓM 8: [FIX] Không báo động nhầm vì từ gần giống từ khóa');

[
    ['Tên "Khang" ≠ "khẩn"', 'Tạ Hoàng Khang\nTui đki'],
    ['"gặp" ≠ "gấp"', 'Mai mình gặp nhau nhé'],
    ['"sắp" ≠ "sập"', 'Sắp đi học rồi'],
    ['"lời" ≠ "lỗi"', 'Nói lời cảm ơn đi'],
    ['"lợi" ≠ "lỗi"', 'Có lợi nhuận không'],
    ['"khăn" ≠ "khẩn"', 'Khăn giấy để đâu'],
    ['"cửu" ≠ "cứu"', 'Về miền Tây Cửu Long chơi'],
].forEach(([name, content], i) => {
    test(name, evaluateMessage({ sender: `Người thường ${i}`, content, isGroup: false }).shouldCall, false);
});

test('Gõ không dấu "server sap roi" vẫn GỌI', evaluateMessage({
    sender: 'Ops', content: 'server sap roi', isGroup: false
}).shouldCall, true);

test('Unicode tổ hợp (NFD) "sập" vẫn GỌI', evaluateMessage({
    sender: 'Ops NFD', content: 'Server sập rồi'.normalize('NFD'), isGroup: false
}).shouldCall, true);

// ═══════════════════════════════════════════════════
// KẾT QUẢ
// ═══════════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(`📊 KẾT QUẢ: ${passed} PASS / ${failed} FAIL / ${passed + failed} TOTAL`);
if (failed === 0) {
    console.log('🎉 TẤT CẢ CÁC TEST ĐỀU PASS!');
} else {
    console.log(`⚠️  CÓ ${failed} TEST THẤT BẠI!`);
    process.exit(1);
}
