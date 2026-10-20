import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const userDataDir = path.resolve(__dirname, '../user_data');

/**
 * Khởi tạo Trình duyệt với Persistent Context để lưu phiên đăng nhập
 * @param {boolean} headless - Chạy ẩn hay hiện cửa sổ
 */
export async function initBrowser(headless = false) {
    // BROWSER_CHANNEL=msedge: dùng Edge có sẵn trên máy khi chưa tải Chromium của Playwright
    const channel = process.env.BROWSER_CHANNEL || undefined;
    console.log(`[Browser] Đang khởi động ${channel || 'Chromium'} (${headless ? 'Chế độ Chạy Ẩn Headless' : 'Chế độ Hiện Cửa Sổ'})...`);
    console.log(`[Browser] Dữ liệu phiên lưu tại: ${userDataDir}`);

    const context = await chromium.launchPersistentContext(userDataDir, {
        channel,
        headless: headless,
        acceptDownloads: true,   // bot tự bấm "Lưu về máy" file có lịch (src/autoplan.js)
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-infobars',
            '--window-size=1280,800'
        ]
    });

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    console.log('[Browser] Đang mở https://chat.zalo.me...');
    await page.goto('https://chat.zalo.me', { waitUntil: 'domcontentloaded', timeout: 45000 });

    return { context, page };
}
