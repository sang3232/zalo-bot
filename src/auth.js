/**
 * Module quản lý và kiểm tra trạng thái xác thực Zalo Web
 */

export async function checkLoginStatus(page) {
    try {
        // Chờ 3 giây để trang load các thành phần
        await page.waitForTimeout(3000);

        // Các selector đánh dấu đã đăng nhập thành công vào Zalo Web
        const loggedInSelectors = [
            '#main-tab',
            '#chatView',
            '.nav__tabs',
            'div[data-translate-inner="STR_MENU_CHAT"]',
            '.left-sidebar-item',
            '#conv-list'
        ];

        for (const selector of loggedInSelectors) {
            const el = await page.$(selector);
            if (el) {
                return { isLoggedIn: true };
            }
        }

        // Kiểm tra xem có đang ở trang QR Code không
        const qrSelectors = [
            '.qrcode',
            '.qr-container',
            'img[alt="QR Code"]',
            '.canvas-qr-code',
            'canvas'
        ];

        for (const selector of qrSelectors) {
            const el = await page.$(selector);
            if (el) {
                return { isLoggedIn: false, hasQrCode: true };
            }
        }

        return { isLoggedIn: false, hasQrCode: false };
    } catch (error) {
        return { isLoggedIn: false, error: error.message };
    }
}

export async function waitForLogin(page, timeoutMs = 120000) {
    console.log('\n[Xác thực] Đang đợi bạn quét mã QR trên điện thoại...');
    console.log('[Xác thực] Hãy mở ứng dụng Zalo trên điện thoại -> Bấm vào biểu tượng quét QR -> Quét mã trên màn hình.');

    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        const status = await checkLoginStatus(page);
        if (status.isLoggedIn) {
            console.log('\n✅ [Xác thực] Đăng nhập Zalo Web THÀNH CÔNG! Đã lưu phiên đăng nhập.');
            return true;
        }
        await page.waitForTimeout(2000);
    }

    throw new Error('Quá thời gian chờ quét mã QR (2 phút). Vui lòng chạy lại chương trình.');
}
