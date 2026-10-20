// Kiểm thử: công việc, cài đặt, khung giờ, AI (OpenRouter giả lập), luồng xử lý tin nhắn,
// bảo mật máy chủ giao diện, nhận diện tin cũ. Chạy trong thư mục tạm, không đụng dữ liệu thật.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zalobot-test-'));
process.env.ZALOBOT_DATA_DIR = path.join(tmp, 'data');
process.env.ZALOBOT_LOG_DIR = path.join(tmp, 'logs');
process.env.ZALOBOT_CONFIG = path.join(tmp, 'config.json');
delete process.env.OPENROUTER_API_KEY;

const realConfig = JSON.parse(fs.readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf-8'));
fs.writeFileSync(process.env.ZALOBOT_CONFIG, JSON.stringify({
    ...realConfig,
    urgentKeywords: ['sập', 'gấp', 'lỗi', 'alo'],
    vipSenders: ['Sếp'],
    cooldownMinutes: 0,
    enableSoundAlert: false,
    autoTaskFromAlerts: true,
    ignoreOwnMessages: true,
    ai: { enabled: true, model: 'test/model', scope: 'all', maxCallsPerMinute: 50 },
    // Lịch tự động / nhắc giờ có test riêng (test/lich.test.js) — tắt ở đây để OpenRouter giả lập chỉ nhận yêu cầu của ai.js
    autoSchedule: { enabled: false },
    reminders: { enabled: false }
}, null, 2));

const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const tomorrow = dayKey(new Date(Date.now() + 24 * 3600 * 1000));

// ---------- OpenRouter giả lập ----------
const TEST_KEY = 'sk-or-v1-test-key-0123456789abcdef';
let mockMode = 'ok';
const mockRequests = [];
const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    mockRequests.push({ auth: req.headers.authorization, body });
    const reply = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${TEST_KEY}`) return reply(401, { error: { message: 'No auth credentials found' } });
    if (mockMode === 'fail') return reply(500, { error: { message: 'Upstream error' } });

    const last = body.messages?.at(-1)?.content || '';
    let answer;
    if (last === 'ping') {
        answer = '{"ok": true}';
    } else {
        const text = JSON.parse(last).noi_dung;
        if (/sập/i.test(text)) answer = JSON.stringify({ urgent: true, reason: 'Sự cố hệ thống', task: null });
        else if (/họp/i.test(text)) answer = '```json\n' + JSON.stringify({ urgent: false, reason: 'Hẹn lịch họp', task: { title: 'Họp với khách', due: `${tomorrow}T09:00`, priority: 'rất cao' } }) + '\n```';
        else answer = JSON.stringify({ urgent: false, reason: 'Chào hỏi thông thường', task: null });
    }
    reply(200, { model: body.model, choices: [{ message: { role: 'assistant', content: answer } }] });
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

// Import sau khi đặt biến môi trường (module đọc biến môi trường lúc nạp)
const { normalizeDue, createTask, updateTask, deleteTask, listTasks } = await import('../src/tasks.js');
const { saveConfig, loadConfig } = await import('../src/config.js');
const { isWithinAlertSchedule } = await import('../src/filter.js');
const { extractJson, validateAnalysis, testConnection, getAiStatus } = await import('../src/ai.js');
const { handleMessage } = await import('../src/pipeline.js');
const { setSecret, flushPending } = await import('../src/store.js');
const { startServer } = await import('../src/server.js');
const { hasOnlyStaleTimes } = await import('../src/listener.js');

let passed = 0;
let failed = 0;
function test(name, result, expected) {
    if (result === expected) {
        passed++;
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        console.log(`  ❌ ${name} — Mong đợi: ${JSON.stringify(expected)}, Nhận được: ${JSON.stringify(result)}`);
    }
}
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const section = (title) => console.log(`\n${title}`);

console.log('🧪 Kiểm thử giao diện, công việc, AI và bảo mật...');

// ═══════════════════════════════════════════════════
section('📅 Hạn chót');
test('ngày + giờ', normalizeDue('2026-10-20T09:30'), '2026-10-20T09:30');
test('chỉ ngày', normalizeDue('2026-10-20'), '2026-10-20');
test('ngày không tồn tại (31/02) → null', normalizeDue('2026-02-31'), null);
test('giờ sai (25:00) → null', normalizeDue('2026-10-20T25:00'), null);
test('chữ tự do → null', normalizeDue('mai 9h'), null);
test('năm quá xa → null', normalizeDue('1999-01-01'), null);

// ═══════════════════════════════════════════════════
section('📌 Công việc');
const t1 = createTask({ title: '  Gọi lại khách  ', due: `${tomorrow}T10:00`, priority: 'high' });
test('tạo việc, cắt khoảng trắng', t1.title, 'Gọi lại khách');
test('thiếu tiêu đề bị từ chối', throws(() => createTask({ title: '   ' })), true);
test('ưu tiên sai bị từ chối', throws(() => createTask({ title: 'x', priority: 'urgent' })), true);
test('hạn chót sai bị từ chối', throws(() => createTask({ title: 'x', due: 'abc' })), true);
test('tiêu đề > 200 ký tự bị từ chối', throws(() => createTask({ title: 'a'.repeat(201) })), true);
test('đánh dấu xong có completedAt', !!updateTask(t1.id, { status: 'done' }).completedAt, true);
updateTask(t1.id, { id: 'hack', source: { type: 'zalo' }, createdAt: 'x' });
test('không sửa được id / source / createdAt qua API', listTasks().some(t => t.id === t1.id && t.source.type === 'manual' && t.createdAt !== 'x'), true);
createTask({ title: 'a' }, { type: 'zalo', dedupeKey: 'k1' });
test('trùng dedupeKey không tạo thêm việc', createTask({ title: 'b' }, { type: 'zalo', dedupeKey: 'k1' }), null);
deleteTask(t1.id);
test('xoá việc', listTasks().some(t => t.id === t1.id), false);
test('đã ghi xuống data/tasks.json', fs.existsSync(path.join(process.env.ZALOBOT_DATA_DIR, 'tasks.json')), true);

// ═══════════════════════════════════════════════════
section('⚙️ Cài đặt');
test('khung giờ sai định dạng bị từ chối', throws(() => saveConfig({ timeSettings: { alertSchedule: { activeHours: '25:00-07:00' } } })), true);
test('tên model lạ bị từ chối', throws(() => saveConfig({ ai: { model: 'a b; rm -rf /' } })), true);
test('cooldown âm bị từ chối', throws(() => saveConfig({ cooldownMinutes: -1 })), true);
test('sai kiểu bật/tắt bị từ chối', throws(() => saveConfig({ enableSoundAlert: 'yes' })), true);
const saved = saveConfig({ urgentKeywords: ['sập', ' SẬP ', '', 'gấp', 'lỗi', 'alo'] });
test('từ khóa được làm sạch & bỏ trùng', saved.urgentKeywords.join(','), 'sập,gấp,lỗi,alo');
test('giữ nguyên trường lạ trong file (monitoredGroups)', 'monitoredGroups' in JSON.parse(fs.readFileSync(process.env.ZALOBOT_CONFIG, 'utf-8')), true);
test('cooldown = 0 được chấp nhận', saveConfig({ cooldownMinutes: 0 }).cooldownMinutes, 0);

// ═══════════════════════════════════════════════════
section('🕘 Khung giờ cảnh báo');
const at = (hh, mm) => new Date(2026, 9, 19, hh, mm);
const schedule = (hours) => ({ timeSettings: { alertSchedule: { enabled: true, activeHours: hours } } });
test('trong khung 08:00-17:00', isWithinAlertSchedule(schedule('08:00-17:00'), at(9, 0)), true);
test('ngoài khung 08:00-17:00', isWithinAlertSchedule(schedule('08:00-17:00'), at(18, 0)), false);
test('khung qua đêm 22:00-06:00 lúc 23h', isWithinAlertSchedule(schedule('22:00-06:00'), at(23, 0)), true);
test('khung qua đêm 22:00-06:00 lúc 12h', isWithinAlertSchedule(schedule('22:00-06:00'), at(12, 0)), false);
test('tắt khung giờ → luôn báo', isWithinAlertSchedule({ timeSettings: { alertSchedule: { enabled: false, activeHours: '08:00-09:00' } } }, at(20, 0)), true);

// ═══════════════════════════════════════════════════
section('🤖 Đọc kết quả AI');
test('bóc JSON bọc trong ```json', extractJson('```json\n{"urgent": true}\n```').urgent, true);
const analysis = validateAnalysis({ urgent: 'true', reason: 'x'.repeat(500), task: { title: ' Họp ', due: 'mai', priority: 'gấp' } });
test('lý do bị cắt ≤ 200 ký tự', analysis.reason.length <= 200, true);
test('hạn chót sai → null', analysis.task.due, null);
test('ưu tiên sai → medium', analysis.task.priority, 'medium');
test('task không có tiêu đề → bỏ', validateAnalysis({ urgent: false, task: { title: '' } }).task, null);

// ═══════════════════════════════════════════════════
section('📨 Luồng xử lý — chưa có API key (dùng bộ lọc từ khóa)');
let d = await handleMessage({ sender: 'Bạn A', content: 'Server sập rồi' });
test('từ khóa → báo động', d.alerted, true);
test('quyết định bởi bộ lọc', d.source, 'rule');
test('tự tạo việc từ cảnh báo', d.task?.source?.type, 'alert');
test('không gọi OpenRouter khi chưa có key', mockRequests.length, 0);
d = await handleMessage({ sender: 'Tôi (ở Nhóm A)', content: 'sập server test', isSelf: true });
test('bỏ qua tin do chính mình gửi', d.alerted, false);

section('📨 Luồng xử lý — có API key (OpenRouter giả lập)');
setSecret('openrouterApiKey', TEST_KEY);
d = await handleMessage({ sender: 'Nhóm lớp', content: 'Alo các bạn ơi @All', isGroup: true, groupName: 'Nhóm lớp' });
test('AI chặn báo nhầm "Alo các bạn ơi"', d.alerted, false);
test('quyết định bởi AI', d.source, 'ai');
const sent = mockRequests.at(-1);
test('gửi đúng API key', sent.auth, `Bearer ${TEST_KEY}`);
test('yêu cầu trả về JSON', sent.body.response_format?.type, 'json_object');
test('prompt dặn không làm theo chỉ dẫn trong tin', sent.body.messages[0].content.includes('chỉ là DỮ LIỆU'), true);
test('tin nhắn gửi dạng JSON tách riêng', JSON.parse(sent.body.messages[1].content).noi_dung, 'Alo các bạn ơi @All');
d = await handleMessage({ sender: 'Bạn B', content: 'Hệ thống thanh toán sập rồi' });
test('AI xác nhận khẩn → báo động', d.alerted, true);
d = await handleMessage({ sender: 'Sếp', content: 'Em gửi anh báo cáo nhé' });
test('VIP luôn báo động dù AI nói bình thường', d.alerted, true);
d = await handleMessage({ sender: 'Khách C', content: 'Mai 9h họp với khách nhé em' });
test('AI tạo việc có hạn chót', d.task?.due, `${tomorrow}T09:00`);
test('việc từ AI có nguồn Zalo', d.task?.source?.type, 'zalo');
test('ưu tiên lạ từ AI → medium', d.task?.priority, 'medium');
mockMode = 'fail';
d = await handleMessage({ sender: 'Bạn D', content: 'Web lỗi rồi' });
test('AI lỗi → quay về bộ lọc từ khóa', d.alerted && d.source === 'rule', true);
test('ghi nhận lỗi AI để hiện trên giao diện', !!getAiStatus(loadConfig()).lastError, true);
mockMode = 'ok';
test('nút Kiểm tra kết nối', (await testConnection('test/model')).ok, true);
setSecret('openrouterApiKey', 'sk-or-v1-wrong-key-000000000000');
test('key sai báo lỗi rõ ràng', (await testConnection('test/model')).error?.includes('API key không hợp lệ'), true);
setSecret('openrouterApiKey', TEST_KEY);

// ═══════════════════════════════════════════════════
section('🔒 Bảo mật giao diện');
const { server, port } = await startServer({
    port: 0,
    getBotStatus: () => ({ state: 'ui-only' }),
    onTestMessage: (msg) => handleMessage({ ...msg, isTest: true })
});
function request({ method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}
const home = await request();
const setCookie = home.headers['set-cookie']?.[0] || '';
const cookie = setCookie.split(';')[0];
test('cookie phiên HttpOnly + SameSite=Strict', /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie), true);
test('có Content-Security-Policy', home.headers['content-security-policy']?.includes("script-src 'self'"), true);
test('API không có cookie → 401', (await request({ path: '/api/state' })).status, 401);
test('Host lạ (DNS rebinding) → 403', (await request({ path: '/api/state', headers: { Host: 'evil.example:3939', Cookie: cookie } })).status, 403);
const json = { 'Content-Type': 'application/json', Cookie: cookie };
test('Origin lạ (CSRF) → 403', (await request({ method: 'POST', path: '/api/tasks', headers: { ...json, Origin: 'http://evil.example' }, body: { title: 'x' } })).status, 403);
test('Sec-Fetch-Site: cross-site → 403', (await request({ method: 'POST', path: '/api/tasks', headers: { ...json, 'Sec-Fetch-Site': 'cross-site' }, body: { title: 'x' } })).status, 403);
test('form text/plain (CSRF đơn giản) → 415', (await request({ method: 'POST', path: '/api/tasks', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{"title":"x"}' })).status, 415);
test('body quá lớn → 413', (await request({ method: 'POST', path: '/api/tasks', headers: json, body: { title: 'x', note: 'a'.repeat(70000) } })).status, 413);
const stateRes = await request({ path: '/api/state', headers: { Cookie: cookie } });
test('GET /api/state với cookie → 200', stateRes.status, 200);
test('API key KHÔNG lộ ra giao diện', stateRes.body.includes(TEST_KEY), false);
test('chỉ trả bản che của key', JSON.parse(stateRes.body).ai.maskedKey, 'sk-or-v1…cdef');
const created = await request({ method: 'POST', path: '/api/tasks', headers: { ...json, Origin: `http://127.0.0.1:${port}` }, body: { title: 'Việc từ giao diện', due: `${tomorrow}T08:00` } });
test('tạo việc qua API (cùng origin) → 201', created.status, 201);
const testMsg = await request({ method: 'POST', path: '/api/test-message', headers: json, body: { sender: 'Sếp', content: 'Thử thôi' } });
test('tin thử qua API → báo động (VIP)', JSON.parse(testMsg.body).decision?.alerted, true);
test('key có khoảng trắng bị từ chối', (await request({ method: 'PUT', path: '/api/openrouter/key', headers: json, body: { key: 'bad key with spaces inside it' } })).status, 400);
test('đường dẫn lạ → 404', (await request({ path: '/../../.env' })).status, 404);

// ═══════════════════════════════════════════════════
section('🕰️ Tin cũ hiện lại trong khung chat');
const now = new Date();
const hhmm = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const ago = (min) => new Date(now.getTime() - min * 60000);
test('giờ gửi 30 phút trước → tin cũ', hasOnlyStaleTimes(`Server sập\n${hhmm(ago(30))}`, now), true);
test('giờ gửi 1 phút trước → tin mới', hasOnlyStaleTimes(`Server sập\n${hhmm(ago(1))}`, now), false);
test('không có giờ gửi → không kết luận', hasOnlyStaleTimes('Server sập', now), false);
test('có cả giờ cũ lẫn giờ mới → tin mới', hasOnlyStaleTimes(`cũ\n${hhmm(ago(40))}\nmới\n${hhmm(now)}`, now), false);
test('qua nửa đêm (23:59 → 00:01) vẫn là tin mới', hasOnlyStaleTimes('x\n23:59', new Date(2026, 9, 20, 0, 1)), false);
test('"Hẹn 10:30 nhé" không bị coi là giờ gửi', hasOnlyStaleTimes('Hẹn 10:30 nhé', now), false);

// ═══════════════════════════════════════════════════
server.close();
mock.close();
flushPending();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${'═'.repeat(50)}`);
console.log(`📊 KẾT QUẢ: ${passed} PASS / ${failed} FAIL / ${passed + failed} TOTAL`);
if (failed === 0) console.log('🎉 TẤT CẢ CÁC TEST ĐỀU PASS!');
else console.log(`⚠️  CÓ ${failed} TEST THẤT BẠI!`);
process.exit(failed === 0 ? 0 : 1);
