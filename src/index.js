// Nạp .env TRƯỚC mọi module khác (một số module đọc biến môi trường ngay khi được import)
import 'dotenv/config';
import { exec } from 'child_process';
import { initBrowser } from './browser.js';
import { checkLoginStatus, waitForLogin } from './auth.js';
import { startMessageListener } from './listener.js';
import { ganTrang, khoiDongLichTuDong } from './autoplan.js';
import { batDauNhacLich } from './reminders.js';
import { loadConfig } from './filter.js';
import { handleMessage } from './pipeline.js';
import { getAiStatus } from './ai.js';
import { startServer } from './server.js';
import { bus } from './bus.js';
import { logger } from './logger.js';

// Tham số dòng lệnh: --headless=true|false, --ui-only (chỉ giao diện, không mở Zalo), --open (mở trình duyệt)
const args = process.argv.slice(2);
const headlessArg = args.find(a => a.startsWith('--headless='));
let isHeadless = process.env.HEADLESS === 'true';
if (headlessArg) {
    isHeadless = headlessArg.split('=')[1] === 'true';
}
const uiOnly = args.includes('--ui-only');
const openUi = args.includes('--open');
const UI_PORT = Number(process.env.UI_PORT) || 3939;
// Mã thoát riêng khi bot đã chạy ở cửa sổ khác (start-zalobot.bat dựa vào mã này để không tự khởi động lại)
const EXIT_ALREADY_RUNNING = 2;

console.log(`
╔══════════════════════════════════════════════════════════════╗
║              ZALO WEB EMERGENCY MONITOR                      ║
║   Theo dõi Zalo · Báo động tin khẩn · Lịch & công việc       ║
╚══════════════════════════════════════════════════════════════╝
`);

// FIX: Số lần thử reconnect tối đa
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5000;
const HEARTBEAT_MS = 60000;
const HEARTBEAT_TIMEOUT_MS = 15000;

const botStatus = { state: 'starting', detail: '', since: Date.now() };
function setBotStatus(state, detail = '') {
    Object.assign(botStatus, { state, detail, since: Date.now() });
    bus.emit('status', { ...botStatus });
}

async function main() {
    const config = loadConfig();
    const ai = getAiStatus(config);
    logger.info(`Từ khóa khẩn cấp  : ${config.urgentKeywords?.length || 0} từ khóa`);
    logger.info(`Người gửi VIP     : ${config.vipSenders?.join(', ') || 'Chưa thiết lập'}`);
    logger.info(`Phân tích AI      : ${!ai.enabled ? 'Tắt' : ai.hasKey ? `Bật (${ai.model})` : 'Bật nhưng chưa có API key OpenRouter → dùng bộ lọc từ khóa'}`);
    logger.info(`Thời gian Cooldown: ${config.cooldownMinutes ?? 3} phút`);

    let browserContext = null;
    let page = null;
    let retryCount = 0;
    let heartbeatTimer = null;
    // FIX: Mỗi phiên trình duyệt có một "thế hệ" riêng. Handler close/crash/heartbeat của phiên cũ
    //      bị bỏ qua, nên việc đóng browser cũ không kích hoạt thêm một lượt reconnect nữa.
    let generation = 0;
    let reconnecting = false;
    let shuttingDown = false;

    // FIX: Đăng ký ngay từ đầu (Ctrl+C trong lúc chờ quét QR / đang reconnect vẫn đóng trình duyệt an toàn)
    process.on('SIGINT', async () => {
        shuttingDown = true;
        logger.info('Đang đóng trình duyệt và dừng bot an toàn...');
        await teardown();
        process.exit(0);
    });

    // FIX: Bắt lỗi unhandled để bot không chết yên lặng
    process.on('unhandledRejection', (reason) => {
        logger.error('⚠️ Lỗi không xử lý (Unhandled Rejection):', String(reason));
    });

    process.on('uncaughtException', (err) => {
        logger.error('⚠️ Lỗi nghiêm trọng (Uncaught Exception):', err.message);
    });

    // Giao diện quản lý — chỉ mở trên chính máy này (127.0.0.1)
    try {
        await startServer({
            port: UI_PORT,
            getBotStatus: () => ({ ...botStatus }),
            onTestMessage: (msg) => handleMessage({ ...msg, isTest: true })
        });
    } catch (e) {
        if (e.code === 'EADDRINUSE') {
            logger.error(`Cổng ${UI_PORT} đang được dùng — có thể bot đã chạy ở một cửa sổ khác. Mở http://127.0.0.1:${UI_PORT}/ để xem.`);
            process.exit(EXIT_ALREADY_RUNNING);
        }
        throw e;
    }
    const uiUrl = `http://127.0.0.1:${UI_PORT}/`;
    logger.info(`🖥️  Giao diện quản lý: ${uiUrl}`);
    if (openUi && process.platform === 'win32') {
        exec(`start "" "${uiUrl}"`);
    }

    // Nhắc lịch + hộp file thả tay chạy độc lập với Zalo Web (Zalo rớt mạng / --ui-only vẫn nhắc đúng giờ)
    batDauNhacLich();
    khoiDongLichTuDong();

    if (uiOnly) {
        setBotStatus('ui-only', 'Chạy với --ui-only: không mở Zalo Web');
        logger.info('Chế độ chỉ giao diện (--ui-only): không mở Zalo Web. Nhấn Ctrl+C để dừng.');
        return;
    }

    // Đóng phiên trình duyệt hiện tại và vô hiệu hóa mọi handler của nó
    async function teardown() {
        generation++;
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;

        const ctx = browserContext;
        browserContext = null;
        page = null;
        if (ctx) {
            try { await ctx.close(); } catch (e) {}
        }
    }

    // Theo dõi page crash/close + heartbeat để tự động reconnect
    function watchSession(currentPage) {
        const gen = generation;
        const isStale = () => gen !== generation || shuttingDown;

        currentPage.on('crash', () => {
            if (isStale()) return;
            logger.error('💥 Trang Zalo Web bị CRASH! Đang thử kết nối lại...');
            attemptReconnect();
        });

        currentPage.on('close', () => {
            if (isStale()) return;
            logger.warn('⚠️ Tab Zalo Web bị đóng! Đang thử mở lại...');
            attemptReconnect();
        });

        // Heartbeat kiểm tra trang còn sống không (có timeout để phát hiện cả trang bị treo)
        heartbeatTimer = setInterval(async () => {
            if (isStale() || reconnecting) return;
            try {
                await Promise.race([
                    currentPage.evaluate(() => document.title),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Heartbeat timeout')), HEARTBEAT_TIMEOUT_MS))
                ]);
            } catch (e) {
                if (isStale()) return;
                logger.error('💔 Mất kết nối với trang Zalo Web! Đang thử kết nối lại...');
                attemptReconnect();
            }
        }, HEARTBEAT_MS);
    }

    // Kết nối một lần. Trả về true nếu thành công.
    async function connectOnce() {
        try {
            setBotStatus('connecting', 'Đang mở Zalo Web');
            const browser = await initBrowser(isHeadless);
            browserContext = browser.context;
            page = browser.page;

            // 1. Kiểm tra trạng thái đăng nhập
            const authStatus = await checkLoginStatus(page);

            if (!authStatus.isLoggedIn) {
                if (isHeadless) {
                    logger.warn('Bạn chưa đăng nhập và đang chạy ở chế độ ẩn (HEADLESS=true).');
                    logger.warn('Vui lòng tắt bot rồi chạy quet-qr.bat (hoặc npm run dev) để quét mã QR.');
                }
                setBotStatus('qr', isHeadless
                    ? 'Bot đang chạy ẩn nên không quét được — tắt bot rồi mở quet-qr.bat'
                    : 'Mở cửa sổ Chromium và quét mã bằng app Zalo trên điện thoại');
                // Chờ người dùng quét mã QR
                await waitForLogin(page, 120000);
            } else {
                logger.info('✅ Đã tìm thấy phiên đăng nhập Zalo Web hợp lệ!');
            }

            // 2. Bắt đầu lắng nghe tin nhắn
            setBotStatus('connecting', 'Đang ghi nhớ tin nhắn cũ (không báo động tin cũ)');
            await startMessageListener(page, handleMessage);
            watchSession(page);
            ganTrang(page);   // file tải về trong trình duyệt của bot → lịch tự động

            // Reset retry count khi kết nối thành công
            retryCount = 0;
            setBotStatus('running');
            logger.info('🟢 Bot đang chạy và giám sát tin nhắn Zalo 24/7. Nhấn Ctrl+C để dừng.');
            return true;
        } catch (err) {
            logger.error('Lỗi hệ thống', err.message);
            return false;
        }
    }

    // FIX: Chỉ cho phép MỘT luồng reconnect tại một thời điểm. Trước đây sự kiện 'close', heartbeat
    //      và handler của trang cũ cùng gọi reconnect song song → 2 Chromium mở chung thư mục user_data
    //      ("profile is already in use") và đóng browser của nhau → đốt hết 10 lượt thử trong ~30 giây.
    async function attemptReconnect() {
        if (reconnecting || shuttingDown) return;
        reconnecting = true;
        try {
            while (!shuttingDown) {
                retryCount++;
                if (retryCount > MAX_RETRIES) {
                    setBotStatus('stopped', `Đã thử kết nối lại ${MAX_RETRIES} lần không thành công`);
                    logger.error(`❌ Đã thử kết nối lại ${MAX_RETRIES} lần mà không thành công. Bot dừng lại.`);
                    process.exit(1);
                }

                setBotStatus('reconnecting', `Lần thử ${retryCount}/${MAX_RETRIES}`);
                logger.info(`🔄 Thử kết nối lại lần ${retryCount}/${MAX_RETRIES} sau ${RETRY_DELAY_MS / 1000} giây...`);

                // Đóng hẳn browser cũ (giải phóng user_data) trước khi mở lại
                await teardown();
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));

                if (await connectOnce()) return;
            }
        } finally {
            reconnecting = false;
        }
    }

    if (!(await connectOnce())) {
        await attemptReconnect();
    }
}

main().catch(err => {
    logger.error('Lỗi khởi động', err?.message || String(err));
    process.exit(1);
});
