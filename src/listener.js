import crypto from 'crypto';
import { logger } from './logger.js';
import { readJson, debouncedWriter } from './store.js';

/**
 * Module lắng nghe tin nhắn Zalo Web và lọc bỏ tin cũ.
 * Các lớp chống "tin cũ bị coi là tin mới" (nguyên nhân các lần báo động nhầm trong log):
 *  1. Giai đoạn khởi động: tin Zalo render ra chỉ được ghi nhớ (cache) cho tới khi danh sách ổn định
 *  2. Mở / chuyển đoạn chat, hoặc nhiều tin hiện ra cùng lúc → coi là lịch sử
 *  3. Danh sách hội thoại: nhãn giờ phải là "vừa xong" (Vài giây / 1-2 phút) mới là tin mới
 *  4. Khung chat: tin nằm dưới thanh ngày khác "Hôm nay" → tin cũ; giờ gửi (HH:mm) đã qua quá 3 phút → tin cũ
 *  5. Dấu vân tay tin đã thấy được lưu xuống đĩa 24 giờ → khởi động lại bot không báo lại tin cũ
 * Bộ chọn DOM soi trên Zalo Web thật ngày 01/10/2026 (tools/soi_zalo.mjs). Bộ chọn cũ là đoán: thanh bên
 * không khớp phần tử nào (bot không bắt được tin ở đoạn chat đang đóng), tên đoạn chat luôn là
 * "Đoạn chat hiện tại".
 */

const SEEN_FILE = 'seen-messages.json';
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SEEN = 5000;
const MAX_CONTENT_CHARS = 4000;
const FRESH_WINDOW_MIN = 3;
const READY_TIMEOUT_MS = 35000;
// Sau khi Zalo Web tự tải lại trang: chờ một chút rồi gắn lại observer (observer tự có giai đoạn khởi động)
const RELOAD_SETTLE_MS = 5000;
// Chữ giao diện không phải tin nhắn
const UI_NOISE = /^(đang soạn tin|đang nhập|is typing|typing)/i;

// hash → thời điểm thấy lần đầu (ms)
const seen = new Map();
for (const [hash, at] of Object.entries(readJson(SEEN_FILE, {}) || {})) {
    if (typeof at === 'number') seen.set(hash, at);
}
const seenWriter = debouncedWriter(SEEN_FILE, () => Object.fromEntries(seen), 3000);
pruneSeen();

function pruneSeen() {
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [hash, at] of seen) if (at < cutoff) seen.delete(hash);
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
}

function hasSeen(hash) {
    const at = seen.get(hash);
    return at !== undefined && Date.now() - at < SEEN_TTL_MS;
}

function rememberHash(hash) {
    seen.set(hash, Date.now());
    if (seen.size > MAX_SEEN) pruneSeen();
    seenWriter.schedule();
}

export function cleanText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/\/-[a-z0-9_]+/gi, '')
        .replace(/(:\>|:o|:-\(\(|:-h|:\)|:D|<3)/g, '')
        .replace(/\n?\d{1,2}:\d{2}(\n?(Đã gửi|Đã nhận|Đã có trên Cloud))?$/i, '')
        // FIX: Chỉ xoá các dòng giao diện đứng riêng. Trước đây xoá cả "hôm nay"/"phút" nằm trong
        //      nội dung → "họp hôm nay 14h" mất "hôm nay", bot lên lịch không biết là ngày nào.
        .replace(/^(?:Đồng bộ ngay|Phân loại|Hôm nay|Vài giây|\d+\s*phút)$/gim, '')
        .trim();
}

// msgId (id khung tin trong khung chat) giúp hai tin giống hệt nhau ("ok", "ok") vẫn là hai tin
function getMessageHash(sender, content, msgId = '') {
    const raw = `${sender.trim()}:::${content.trim()}${msgId ? `:::${msgId}` : ''}`;
    return crypto.createHash('md5').update(raw).digest('hex');
}

/**
 * FIX: Tin hiện lại trong khung chat (cuộn lịch sử, mở lại đoạn chat, Zalo render lại) mang giờ gửi cũ.
 * Zalo ghi giờ gửi "HH:mm" dưới bubble (chỉ ở tin cuối của một chuỗi tin liền nhau). Nếu có giờ gửi và
 * TẤT CẢ đều đã qua quá FRESH_WINDOW_MIN phút → tin cũ. Không có giờ → không kết luận.
 */
export function hasOnlyStaleTimes(rawText, now = new Date()) {
    const times = [...String(rawText).matchAll(/^\s*(\d{1,2}):(\d{2})\s*$/gm)]
        .map(m => Number(m[1]) * 60 + Number(m[2]))
        .filter(t => t < 24 * 60);
    if (times.length === 0) return false;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return times.every(t => {
        const diff = (nowMin - t + 1440) % 1440;
        return diff > FRESH_WINDOW_MIN && diff < 1440 - FRESH_WINDOW_MIN;
    });
}

/**
 * Khởi động hệ thống lắng nghe tin nhắn trên trang Zalo Web
 * @param {import('playwright').Page} page
 * @param {Function} onMessageCallback - Callback khi có tin nhắn mới
 */
export async function startMessageListener(page, onMessageCallback) {
    logger.info('Đang khởi tạo bộ lắng nghe tin nhắn (tin cũ chỉ được ghi nhớ, không báo động)...');

    // 1. Nhận tin nhắn từ Trình duyệt (dữ liệu từ trang web → luôn kiểm tra kiểu & giới hạn độ dài)
    try {
        await page.exposeFunction('__dispatchZaloMessage', (msg) => {
            if (!msg || typeof msg.content !== 'string') return;

            const raw = msg.content.slice(0, MAX_CONTENT_CHARS);
            const cleaned = cleanText(raw);
            const sender = String(msg.sender || 'Tin nhắn Zalo').trim().slice(0, 200);
            if (!cleaned || cleaned.length < 2 || UI_NOISE.test(cleaned)) return;
            const msgId = typeof msg.msgId === 'string' ? msg.msgId.slice(0, 100) : '';

            const hash = getMessageHash(sender, cleaned, msgId);
            if (hasSeen(hash)) return;
            rememberHash(hash);

            // Tin cũ: đã ghi nhớ hash ở trên, không xử lý tiếp
            if (msg.isOld || !msg.isLiveEvent) return;

            if (msg.kind === 'chat' && hasOnlyStaleTimes(String(msg.gioGui || ''))) {
                logger.info(`[Listener] Bỏ qua tin cũ hiện lại trong khung chat (giờ gửi đã qua): ${sender}`);
                return;
            }

            const file = msg.file && typeof msg.file.ten === 'string'
                ? { ten: msg.file.ten.slice(0, 260), dungLuong: String(msg.file.dungLuong || '').slice(0, 30) }
                : null;
            Promise.resolve(onMessageCallback({
                sender,
                content: cleaned,
                isGroup: !!msg.isGroup,
                groupName: String(msg.groupName || sender).slice(0, 200),
                // Người gửi thật (trong nhóm: tên thành viên; tin của mình: "Tôi"); sender vẫn là tên đoạn chat
                nguoiGui: String(msg.nguoiGui || '').slice(0, 200),
                isSelf: !!msg.isSelf,
                file,                                        // { ten, dungLuong } — thẻ file
                soAnh: Number(msg.soAnh) || 0,
                msgId,
                guiLuc: Number(msg.guiLuc) || 0,                // lúc gửi thật (ms), 0 = không rõ
                kind: msg.kind === 'chat' ? 'chat' : 'conv', // 'chat' = khung chat đang mở, 'conv' = thanh bên
                timestamp: new Date().toLocaleTimeString('vi-VN')
            })).catch(err => {
                logger.error('[Listener] Lỗi khi xử lý tin nhắn', err?.message || String(err));
            });
        });
    } catch (e) {
        // FIX: Nếu hàm đã được expose trước đó (page reload), bỏ qua lỗi
        if (e.message && e.message.includes('has been already registered')) {
            logger.info('[Listener] Hàm dispatch đã được đăng ký trước đó, tiếp tục...');
        } else {
            throw e;
        }
    }

    // 2. Inject Script quan sát DOM
    await injectObserver(page);

    // FIX: Nếu Zalo Web tự tải lại trang, MutationObserver cũ mất theo → bot vẫn "sống" (heartbeat OK)
    //      nhưng không bắt được tin nào nữa. Gắn lại observer sau mỗi lần trang load.
    page.on('load', async () => {
        try {
            await page.waitForTimeout(RELOAD_SETTLE_MS);
            await injectObserver(page);
            logger.info('[Listener] Trang Zalo Web vừa tải lại → đã gắn lại bộ lắng nghe tin nhắn.');
        } catch (e) {
            logger.warn(`[Listener] Không gắn lại được bộ lắng nghe sau khi trang tải lại: ${e.message}`);
        }
    });

    // 3. Chờ hết giai đoạn khởi động (Zalo render xong danh sách → toàn bộ tin hiện có đã vào cache)
    const ready = await page.waitForFunction(() => window.__zaloBotReady === true, null, { timeout: READY_TIMEOUT_MS })
        .then(() => true, () => false);
    logger.info(ready
        ? '✅ Đã ghi nhớ tin nhắn cũ. Từ giờ chỉ tin MỚI mới được xử lý.'
        : '⚠️ Zalo Web render chậm, bộ lắng nghe vẫn chạy và tự sẵn sàng khi danh sách ổn định.');
}

/**
 * Inject Script quan sát DOM vào trang (gọi nhiều lần trên cùng một trang vẫn an toàn)
 * @param {import('playwright').Page} page
 */
async function injectObserver(page) {
    await page.evaluate(quanSatTrang);
}

/**
 * Chạy TRONG trang Zalo Web (page.evaluate) — không dùng được biến bên ngoài hàm này.
 */
function quanSatTrang() {
    // Không gắn 2 observer lên cùng một trang
    if (window.__zaloBotObserver) return;

    console.log('[ZaloBot] Nạp danh sách tin cũ vào bộ nhớ đệm...');

    // Bộ chọn soi trên Zalo Web thật ngày 01/10/2026. Dòng ghi "(đoán)" là chưa thấy trên trang thật.
    const SEL = {
        tieuDe: '#header .header-title, .threadChat__title .header-title',
        tinNhan: '.chat-item',                                   // một hàng tin; tin của mình có thêm .me
        laToi: '.message-wrapper--me',
        khungTin: '.chat-message[id]',                           // id = mã tin, giữ nguyên khi render lại
        khoiNgay: '.block-date',                                 // mỗi ngày một khối: [.chat-date][.chat-item...]
        thanhNgay: '.chat-date',
        gioGui: '.card-send-time__sendTime',
        theFile: '.file-message__container',
        tenFile: '.file-message__content-title',                 // thuộc tính title = tên file đầy đủ
        dungLuong: '.file-message__content-info-size',
        anh: 'img.zimg-el',                                      // ảnh trong tin (ảnh đại diện là img.a-child)
        nguoiGuiTrongNhom: '[class*="sender-name" i]',           // (đoán) tên thành viên trên tin trong nhóm
        hoiThoai: '.msg-item',                                   // một dòng ở thanh bên
        tenHoiThoai: '.conv-item-title__name',
        xemTruoc: '.z-conv-message__preview-message',
        nguoiGuiXemTruoc: '.z-conv-message__preview-sender-name', // "Bạn" / tên thành viên nhóm
        bieuTuongXemTruoc: '.z-conv-message__preview-icon',
        gioXemTruoc: '.preview-time',
        anhNhieuNguoi: '.zavatar-multi',                         // ảnh đại diện ghép nhiều người = nhóm
        // Chat với chính mình ("My Documents" / "Cloud của tôi"): dòng ghim ở thanh bên + dòng phụ dưới tiêu đề
        chatRieng: '.msg-item[data-id="div_TabMsg_ThrdChFileXFER"]',
        tieuDePhuChatRieng: '#header [data-translate-inner="STR_SEND2ME_STATUS_TEXT_CLOUD"]'
    };
    // Phần trong khung tin không phải nội dung: giờ gửi, trạng thái, cảm xúc, menu nổi, nhãn Cloud...
    const BO_QUA = [
        '.message-reaction-container', '.emoji-list-wrapper', '.react-effect',
        '.message-content-send-time-wrapper', '.bubble-message-time-status', '.card-send-time',
        '.bubble-message-status', '.floating-menu-wrapper', '.cloud-status',
        '.file-message__content-info-preview-file', '.file-message__content-actions',
        '.image-box__preview-thumb', '.qu-ba', SEL.nguoiGuiTrongNhom, 'script', 'style'
    ].join(', ');
    const KHOI = /^(DIV|P|LI|UL|OL|TR|TABLE|SECTION|ARTICLE|HEADER|FOOTER|BLOCKQUOTE|PRE|H[1-6])$/;

    // Khi mở / chuyển sang một đoạn chat, Zalo render cả lịch sử cùng lúc → không được coi là tin mới
    const SETTLE_MS = 2500;   // Sau khi đổi đoạn chat, mọi tin render trong khoảng này là lịch sử
    const BURST_LIMIT = 6;    // Một lượt mutation thêm nhiều hơn số tin này → lịch sử
    const QUET_THANH_BEN_MS = 400;
    const TIN_MOI_MS = 5 * 60 * 1000;   // gửi quá 5 phút trước (theo giờ gửi thật của tin) → tin cũ

    // FIX (tin cũ lúc khởi động / Zalo tải lại): chỉ sẵn sàng khi danh sách đã "yên" WARMUP_QUIET_MS;
    //      trong lúc chờ, mọi tin chỉ được ghi nhớ.
    const WARMUP_MIN_MS = 5000;
    const WARMUP_QUIET_MS = 2500;
    const WARMUP_MAX_MS = 30000;
    const startedAt = Date.now();
    let lastActivity = Date.now();
    let isReady = false;
    window.__zaloBotReady = false;

    const nhomTheoTen = new Map();      // tên đoạn chat → là nhóm? (học từ thanh bên)
    const xemTruocCu = new Map();       // tên đoạn chat → nội dung xem trước lần quét trước
    let tenChatRieng = '';              // tên chat với chính mình (học từ thanh bên)

    function getChatTitle() {
        const el = document.querySelector(SEL.tieuDe);
        return el ? el.textContent.trim() : 'Đoạn chat hiện tại';
    }

    // Tin trong chat với chính mình KHÔNG tính là "tin của tôi": Chủ nhân dùng nó để tự báo động
    // (VIP "My Documents" / "Cloud của tôi" trong config.json) và để ghi chú lịch.
    function laChatRieng(title) {
        return (!!tenChatRieng && title === tenChatRieng) || !!document.querySelector(SEL.tieuDePhuChatRieng);
    }

    // Chữ trong một phần tử, mỗi khối một dòng, bỏ phần giao diện (BO_QUA). Không dùng innerText vì
    // innerText kéo theo giờ gửi / số cảm xúc → thả tim vào tin cũ cũng thành "tin mới".
    function layChu(root, boQuaThem) {
        const parts = [];
        (function di(n) {
            if (n.nodeType === 3) { parts.push(n.nodeValue); return; }
            if (n.nodeType !== 1 || n === boQuaThem || n.matches(BO_QUA)) return;
            if (n.tagName === 'BR') { parts.push('\n'); return; }
            const khoi = KHOI.test(n.tagName);
            if (khoi) parts.push('\n');
            for (const c of n.childNodes) di(c);
            if (khoi) parts.push('\n');
        })(root);
        return parts.join('').replace(/[ \t ]+/g, ' ')
            .split('\n').map(s => s.trim()).filter(Boolean).join('\n');
    }

    // Dữ liệu gốc của tin mà Zalo giữ trong React (soi trang thật 20/10/2026): fiber cha cấp 2 của
    // .chat-message có props.data = { msgId, cliMsgId, sendDttm, serverTime, fromUid, dName, ... }
    function duLieuTin(khung) {
        if (!khung) return null;
        const fk = Object.keys(khung).find(k => k.startsWith('__reactFiber$'));
        let f = fk ? khung[fk] : null;
        for (let i = 0; f && i < 8; i++, f = f.return) {
            const d = f.memoizedProps?.data;
            if (d && typeof d === 'object' && ('sendDttm' in d || 'cliMsgId' in d)) return d;
        }
        return null;
    }

    // Lúc gửi (ms). Ưu tiên giờ máy chủ; không đọc được dữ liệu React thì lấy từ id khung tin
    // "bb_msg_id_<13 chữ số>" — 13 chữ số đó là cliMsgId = lúc gửi (khớp giờ Zalo hiện ở cả 10 tin soi).
    function thoiDiemGui(khung, duLieu) {
        for (const v of [duLieu?.serverTime, duLieu?.sendDttm]) {
            const n = Number(v);
            if (n > 1e12 && n < 1e13) return n;
        }
        const m = String(khung?.id || '').match(/^bb_msg_id_(\d{13})/);
        return m ? Number(m[1]) : 0;
    }

    // Tin nằm trong khối ngày nào: thanh ngày "Hôm nay" (STR_TODAY) → mới; ngày khác → cũ
    function laTinCu(item) {
        const khoi = item.closest(SEL.khoiNgay);
        const thanh = khoi && [...khoi.children].find(c => c.matches(SEL.thanhNgay));
        if (!thanh) return false;
        const thamSo = thanh.querySelector('[data-translate-text-arguments]')?.getAttribute('data-translate-text-arguments') || '';
        if (thamSo.includes('STR_TODAY')) return false;
        const chu = thanh.textContent.trim().toLowerCase();
        return !!chu && !/hôm nay|today/.test(chu);
    }

    // Tin mới luôn được Zalo NỐI VÀO CUỐI khung chat. Tin chèn lên trên tin đã có sẵn = lịch sử Zalo tải
    // thêm khi cuộn lên — kể cả tin của hôm nay, ít tin, không ghi giờ gửi (các lớp khác không bắt được).
    function tinChenPhiaTren(items) {
        const tatCa = [...document.querySelectorAll(SEL.tinNhan)];
        let cuoiCu = -1;
        tatCa.forEach((el, i) => { if (!items.has(el)) cuoiCu = i; });
        return new Set(tatCa.filter((el, i) => items.has(el) && i < cuoiCu));
    }

    // Trong nhóm, Zalo chỉ ghi tên ở tin đầu của một chuỗi tin liền nhau → lần ngược lên tìm
    function timNguoiGui(item) {
        let p = item;
        for (let i = 0; p && i < 30; i++, p = p.previousElementSibling) {
            if (!p.matches(SEL.tinNhan)) continue;
            if (p !== item && (p.matches('.me') || p.querySelector(SEL.laToi))) return '';
            const ten = p.querySelector(SEL.nguoiGuiTrongNhom);
            if (ten && ten.textContent.trim()) return ten.textContent.trim();
        }
        return '';
    }

    // Tin nhắn trong khung chat đang mở (item = .chat-item)
    function describeChatNode(item) {
        const title = getChatTitle();
        const rieng = laChatRieng(title);
        const isSelf = !rieng && (item.matches('.me') || !!item.querySelector(SEL.laToi));
        const khungTin = item.querySelector(SEL.khungTin);
        const duLieu = duLieuTin(khungTin);
        // Tên người gửi: dName trong dữ liệu tin (chắc chắn); không có thì tìm khối tên trên bubble (đoán)
        const nguoi = isSelf || rieng ? '' : (String(duLieu?.dName || '').trim() || timNguoiGui(item));

        let file = null;
        const the = item.querySelector(SEL.theFile);
        if (the) {
            const tenEl = the.querySelector(SEL.tenFile);
            const ten = (tenEl?.getAttribute('title') || tenEl?.textContent || '').replace(/\s*\n\s*/g, '').trim();
            const dungLuong = (the.querySelector(SEL.dungLuong)?.textContent || '').trim();
            if (ten) file = { ten, dungLuong };
        }
        const soAnh = item.querySelectorAll(SEL.anh).length;

        let content = layChu(item, the);
        if (file) content = [content, file.ten, file.dungLuong].filter(Boolean).join('\n');
        if (!content && soAnh) content = soAnh > 1 ? `[${soAnh} hình ảnh]` : '[Hình ảnh]';

        const isGroup = !rieng && (nhomTheoTen.has(title) ? nhomTheoTen.get(title) : (!!nguoi || title.includes('Nhóm')));
        return {
            kind: 'chat',
            sender: isSelf ? `Tôi (ở ${title})` : title,
            nguoiGui: isSelf || rieng ? 'Tôi' : (nguoi || (isGroup ? '' : title)),
            content,
            isGroup,
            groupName: title,
            isSelf,
            file,
            soAnh,
            msgId: khungTin?.id || '',
            guiLuc: thoiDiemGui(khungTin, duLieu),
            gioGui: [...item.querySelectorAll(SEL.gioGui)].map(e => e.textContent.trim()).join('\n')
        };
    }

    // FIX: Ở danh sách hội thoại, tin MỚI luôn mang nhãn "Vài giây" / "1 phút"...
    //      Nhãn "2 giờ", "Hôm qua", "T2", "15/07" = tin cũ được render lại.
    function laVuaGui(gioEl) {
        if (!gioEl) return false;
        const khoa = gioEl.querySelector('[data-translate-inner]')?.getAttribute('data-translate-inner') || '';
        const chu = gioEl.textContent.trim().toLowerCase();
        if (khoa === 'STR_FEW_SECONDS' || khoa === 'STR_JUST_NOW' || /vài giây|vừa xong|bây giờ|just now|^now$/.test(chu)) return true;
        let m = chu.match(/^(\d+)\s*(phút|min)/);
        if (khoa === 'STR_MINS' || m) return Number(m?.[1] ?? parseInt(chu, 10)) <= 2;
        m = chu.match(/^(\d{1,2}):(\d{2})$/);
        if (m) {
            const now = new Date();
            const diff = ((now.getHours() * 60 + now.getMinutes()) - (Number(m[1]) * 60 + Number(m[2])) + 1440) % 1440;
            return diff <= 3 || diff >= 1437;
        }
        return false;
    }

    // Một dòng hội thoại ở thanh bên trái
    function docHoiThoai(muc) {
        const tenEl = muc.querySelector(SEL.tenHoiThoai);
        const xt = muc.querySelector(SEL.xemTruoc);
        if (!tenEl || !xt) return null;
        const ten = tenEl.textContent.trim();
        const ngEl = xt.querySelector(SEL.nguoiGuiXemTruoc);
        const nguoi = (ngEl?.textContent || '').trim().replace(/\s*:\s*$/, '');
        const rieng = muc.matches(SEL.chatRieng);
        const laToi = !rieng && /^(bạn|you)$/i.test(nguoi);
        const noiDung = layChu(xt, ngEl).replace(/\n/g, ' ').trim();
        // (đoán) xem trước của file: biểu tượng file + tên file
        const bieuTuong = xt.querySelector(`${SEL.bieuTuongXemTruoc} i`)?.className || '';
        const file = /file|attach/i.test(bieuTuong) && /\.[a-z0-9]{1,5}$/i.test(noiDung) ? { ten: noiDung, dungLuong: '' } : null;
        return {
            ten, nguoi, laToi, rieng, noiDung, file,
            vuaGui: laVuaGui(muc.querySelector(SEL.gioXemTruoc)),
            laNhom: !rieng && (!!muc.querySelector(SEL.anhNhieuNguoi) || (!!nguoi && !laToi))
        };
    }

    // isLive = false → chỉ đưa vào cache, không báo động
    function dispatch(info, isLive) {
        if (!info || !info.content) return;
        window.__dispatchZaloMessage({ ...info, isLiveEvent: isLive, isOld: !isLive });
    }

    // Thanh bên là danh sách React ảo: tin mới đến thì CHỮ trong dòng có sẵn đổi, không có phần tử mới
    // → so nội dung xem trước của từng đoạn chat với lần quét trước.
    function quetThanhBen() {
        const dangMo = getChatTitle();
        let doi = false;
        document.querySelectorAll(SEL.hoiThoai).forEach(muc => {
            const h = docHoiThoai(muc);
            if (!h || !h.noiDung) return;
            if (h.rieng) tenChatRieng = h.ten;
            nhomTheoTen.set(h.ten, h.laNhom);
            const kyHieu = `${h.nguoi}|${h.noiDung}`;
            if (xemTruocCu.get(h.ten) === kyHieu) return;
            xemTruocCu.set(h.ten, kyHieu);
            doi = true;
            // Đoạn chat đang mở thì khung chat báo tin đầy đủ hơn — thanh bên chỉ đưa vào cache
            const live = isReady && h.vuaGui && h.ten !== dangMo;
            dispatch({
                kind: 'conv',
                sender: h.laToi ? `Tôi (ở ${h.ten})` : h.ten,
                nguoiGui: h.laToi || h.rieng ? 'Tôi' : (h.laNhom ? h.nguoi : h.ten),
                content: h.noiDung,
                isGroup: h.laNhom,
                groupName: h.ten,
                isSelf: h.laToi,
                file: h.file
            }, live);
        });
        if (doi) lastActivity = Date.now();
    }

    // Quét toàn bộ tin cũ ban đầu để đưa vào cache
    function initialCacheScan() {
        quetThanhBen();
        document.querySelectorAll(SEL.tinNhan).forEach(el => dispatch(describeChatNode(el), false));
    }

    initialCacheScan();

    const readyTimer = setInterval(() => {
        const now = Date.now();
        const quiet = now - lastActivity >= WARMUP_QUIET_MS;
        if ((now - startedAt >= WARMUP_MIN_MS && quiet) || now - startedAt >= WARMUP_MAX_MS) {
            clearInterval(readyTimer);
            isReady = true;
            window.__zaloBotReady = true;
            console.log('[ZaloBot] Đã sẵn sàng bắt tin nhắn mới!');
        }
    }, 500);

    let lastTitle = getChatTitle();
    let settleUntil = 0;
    let henQuet = null;

    // Theo dõi tin mới thêm vào khung chat + chữ thay đổi tại chỗ trong danh sách hội thoại
    const observer = new MutationObserver((mutations) => {
        // Đổi đoạn chat → lịch sử sắp được render, coi như tin cũ trong một khoảng ngắn
        const title = getChatTitle();
        if (title !== lastTitle) {
            lastTitle = title;
            settleUntil = Date.now() + SETTLE_MS;
        }

        const items = new Set();
        for (const mutation of mutations) {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType !== 1 || !node.matches) return;
                if (node.matches(SEL.tinNhan)) items.add(node);
                else node.querySelectorAll(SEL.tinNhan).forEach(n => items.add(n));
            });
        }

        // 1. Tin nhắn trong khung chat (tin cũ / lịch sử vẫn được đưa vào cache)
        if (items.size) {
            lastActivity = Date.now();
            const isHistoryRender = !isReady || Date.now() < settleUntil || items.size > BURST_LIMIT;
            const chenTren = isHistoryRender ? null : tinChenPhiaTren(items);
            items.forEach(item => {
                if (!item.isConnected) return;
                const info = describeChatNode(item);
                const guiDaLau = info.guiLuc > 0 && Date.now() - info.guiLuc > TIN_MOI_MS;
                dispatch(info, !isHistoryRender && !chenTren.has(item) && !laTinCu(item) && !guiDaLau);
            });
        }

        // 2. Thanh bên: gom các thay đổi rồi quét một lần
        if (!henQuet) {
            henQuet = setTimeout(() => {
                henQuet = null;
                try { quetThanhBen(); } catch (e) { console.warn('[ZaloBot] Lỗi quét thanh bên', e); }
            }, QUET_THANH_BEN_MS);
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });
    window.__zaloBotObserver = observer;
}
