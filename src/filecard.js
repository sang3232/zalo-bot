/**
 * Nhận ra "thẻ file" trong tin nhắn Zalo Web qua innerText mà listener gửi về.
 * Dạng đã thấy trong logs/app.log:
 *   "Un\nit6.docx\n17.56 KB"                    → Unit6.docx
 *   "dap_an_10_t\nphcm.pdf\n104.9 KB"           → dap_an_10_tphcm.pdf
 *   "Screenshot 2026-03-06 20\n1501.png\n1.34 MB" → Screenshot 2026-03-06 201501.png
 * Zalo tách tên thành [phần đầu][8 ký tự cuối có đuôi file] để cắt "..." ở giữa tên dài.
 * Tên ngắn hơn 8 ký tự thì chỉ còn một dòng.
 */

const TAIL_LEN = 8;
const EXT_RE = /\.([a-z0-9]{1,5})$/i;
const SIZE_RE = /^(\d+(?:[.,]\d+)?)\s*(B|KB|MB|GB)$/i;
// Xem trước ở thanh bên (chưa kiểm trên DOM thật) — "[File] ten.pdf"
const SIDEBAR_RE = /^\s*\[(?:File|Tệp tin|Tệp)\]\s*(.+?\.[a-z0-9]{1,5})\s*$/im;
const UNIT = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/**
 * @returns {null | { ten: string, duoi: string, dungLuong: string, soByte: number, dongTruoc: string[] }}
 */
export function timTheFile(content) {
    const text = String(content || '');
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);

    for (let i = 1; i < lines.length; i++) {
        const size = lines[i].match(SIZE_RE);
        if (!size) continue;
        const duoiTen = lines[i - 1];
        if (!EXT_RE.test(duoiTen)) continue;

        let ten = duoiTen;
        let batDau = i - 1;
        if (duoiTen.length === TAIL_LEN && i >= 2 && !SIZE_RE.test(lines[i - 2])) {
            ten = lines[i - 2] + duoiTen;
            batDau = i - 2;
        }
        const donVi = size[2].toUpperCase();
        return {
            ten,
            duoi: ten.match(EXT_RE)[1].toLowerCase(),
            dungLuong: `${size[1]} ${donVi}`,
            soByte: Math.round(parseFloat(size[1].replace(',', '.')) * UNIT[donVi]),
            // Dòng phía trên thẻ: trong nhóm thường là tên người gửi, có khi là chữ kèm
            dongTruoc: lines.slice(0, batDau)
        };
    }

    const sb = text.match(SIDEBAR_RE);
    if (sb) {
        return { ten: sb[1], duoi: sb[1].match(EXT_RE)[1].toLowerCase(), dungLuong: '', soByte: 0, dongTruoc: [] };
    }
    return null;
}

/**
 * Thẻ file listener đọc thẳng từ khung chat: tên đầy đủ lấy ở thuộc tính title của
 * .file-message__content-title (không bị cắt "..."), dung lượng ở .file-message__content-info-size.
 * Thanh bên chỉ có tên, không có dung lượng.
 */
export function theTuDom(f) {
    const ten = String(f?.ten || '').trim();
    const duoi = ten.match(EXT_RE);
    if (!duoi) return null;
    const size = String(f?.dungLuong || '').trim().match(SIZE_RE);
    const donVi = size ? size[2].toUpperCase() : '';
    return {
        ten,
        duoi: duoi[1].toLowerCase(),
        dungLuong: size ? `${size[1]} ${donVi}` : '',
        soByte: size ? Math.round(parseFloat(size[1].replace(',', '.')) * UNIT[donVi]) : 0,
        dongTruoc: []
    };
}
