# 🚨 Zalo Emergency Monitor

Theo dõi tin nhắn Zalo Web 24/7 bằng **Playwright (Chromium)**. Bot phát hiện tin khẩn cấp (theo từ khóa, người gửi VIP, hoặc AI qua **OpenRouter**), báo động trên máy tính và trên **giao diện quản lý**, và tự ghi lại **công việc / lịch hẹn** từ tin nhắn.

> Đã gỡ bỏ gọi điện (Stringee / Twilio / CallMeBot) và Telegram. Báo động giờ gồm: còi trên máy tính, âm thanh + thông báo trên giao diện, ghi log.

> ⚠️ **Công cụ không chính thức.** Bot mở Zalo Web (chat.zalo.me) bằng trình duyệt tự động và chỉ **đọc** trang. Nó không gửi tin, không tự mở đoạn chat, không lấy cookie ra ngoài. Tự động hoá tài khoản cá nhân có thể không phù hợp với điều khoản của Zalo — bạn tự chịu rủi ro khi dùng.

---

## 📦 Cài đặt (tải từ GitHub)

1. Cài **Node.js 20+** và **Python 3** (đọc file pdf/docx/xlsx: `pip install pypdf python-docx openpyxl`).
2. `npm install`
3. Chép `.env.example` thành `.env`, điền những gì cần (xem chú thích trong file). Lần chạy đầu bot tự tạo `config/config.json` từ `config/config.example.json`.
4. Chạy `quet-qr.bat` (hoặc `npm run dev`) để quét mã QR đăng nhập Zalo, sau đó dùng `start-zalobot.bat`.
5. Giao diện → **Cài đặt** → dán API key OpenRouter.

Không đưa lên GitHub: `.env`, `config/config.json`, `data/` (key, công việc), `user_data/` (phiên Zalo), `logs/` (nội dung tin nhắn).

---

## 🚀 Chạy bot

| File | Dùng khi |
|---|---|
| `start-zalobot.bat` | Bấm đúp để chạy bot và mở giao diện. Bot tự khởi động lại nếu bị dừng. |
| `quet-qr.bat` | Cần quét mã QR đăng nhập Zalo (lần đầu, hoặc khi phiên hết hạn). |
| `mo-giao-dien.bat` | Mở lại giao diện nếu lỡ đóng tab. |

Dòng lệnh: `npm start` · `npm run dev` (hiện Chromium) · `npm run ui` (chỉ giao diện, không mở Zalo) · `npm test`

Lần đầu: chạy `quet-qr.bat` → quét mã QR bằng app Zalo trên điện thoại. Phiên đăng nhập được lưu trong `user_data/`, các lần sau không cần quét lại.

Cần **Node.js** trong PATH (`winget install OpenJS.NodeJS.LTS`). Máy chưa tải Chromium của Playwright thì đặt `BROWSER_CHANNEL=msedge` trong `.env` để dùng Edge có sẵn.

---

## 🖥️ Giao diện quản lý — http://127.0.0.1:3939

- **Tổng quan**: trạng thái bot, cảnh báo & tin nhắn mới (cập nhật trực tiếp), ô **Thử bộ lọc** để chạy một tin giả qua bộ lọc + AI mà không cần Zalo.
- **Lịch**: lịch tháng, công việc hiển thị theo hạn chót; bấm một ngày để xem và thêm việc.
- **Công việc**: thêm / sửa / xoá / đánh dấu xong; lọc Chưa xong · Hôm nay · Quá hạn · Đã xong.
  Công việc được tạo tay, **tự tạo khi có cảnh báo**, **AI trích từ tin nhắn** (VD: "Mai 9h họp với khách nhé"), hoặc **lên lịch từ file / ảnh** (xem bên dưới).
  Mọi việc chưa xong có hạn chót đều được **nhắc giờ** trên giao diện và qua Yuyuko.
- **Cài đặt**: API key OpenRouter, model, phạm vi AI · từ khóa, VIP, cooldown · khung giờ cảnh báo · thông báo trình duyệt.
  Lưu vào `config/config.json`, bot áp dụng ngay không cần khởi động lại.

---

## 🤖 AI qua OpenRouter

1. Tạo key tại https://openrouter.ai/keys
2. Giao diện → **Cài đặt** → dán key → **Lưu key** → **Kiểm tra**.

Model mặc định: `z-ai/glm-5.3-flash` (rẻ, ~1–2 giây/tin; bot cho GLM "nghĩ ít" để khỏi tốn token và trả rỗng). Đổi được trong **Cài đặt**.

Cách bot quyết định:
- Người gửi **VIP** → luôn báo động.
- Còn lại: AI quyết định có khẩn cấp không (giảm báo nhầm như "Alo các bạn ơi"); AI cũng tạo công việc khi tin nhắn giao việc / hẹn lịch.
- AI tắt, chưa có key, lỗi, hoặc vượt số lượt/phút → tự dùng **bộ lọc từ khóa**.
- Phạm vi "Chỉ tin trùng từ khóa / VIP" giúp tiết kiệm lượt gọi.

⚠️ Khi bật AI, **nội dung tin nhắn được gửi tới OpenRouter** và nhà cung cấp model.

---

## 🗓️ Lịch tự động từ file, ảnh & tin nhắn (GLM 5.3 Flash) + nhắc qua Yuyuko

1. **File gửi trong Zalo** (pdf, docx, xlsx, pptx, txt, csv, ảnh): bot chờ 90 giây để gom tin nhắn phía sau file, rồi tự bấm **"Lưu về máy"** nếu đoạn chat đang mở trong trình duyệt của bot.
2. **Đọc file bằng code**: không mở bằng Word/Excel, không chạy macro, không giải nén. Ảnh và PDF scan đi qua máy chủ OCR Trạm 1 của Yuyuko (`OCR_SERVER_URL`).
3. **File có ngày rõ ràng** (dd/mm/yyyy, "15 tháng 10", "hạn nộp", "lịch thi"...) → GLM đọc cả file.
   **Không có** → GLM xem tên file + người gửi + nhóm + tin nhắn trước/sau rồi tự quyết có đáng đọc file không.
4. **Ảnh trong đoạn chat đang mở**: OCR. Có ngày giờ thì xử lý như file, không có thì bỏ qua (không tốn lượt GLM).
   **Máy chủ OCR tắt** → gửi ảnh thẳng cho GLM 5.3 Flash (model đọc được ảnh). File ảnh (tải về / thả tay) luôn được gửi. Ảnh trong khung chat chỉ được gửi khi tin nhắn quanh ảnh (30 phút) có dấu hiệu lịch, để không đẩy mọi ảnh trong nhóm lên mạng. Tắt bằng `autoSchedule.visionFallback: false`.
5. **Tin nhắn: ghép theo cả đoạn hội thoại.** Đoạn chat có manh mối (ngày / giờ / hạn, hoặc "ok, chốt" ngay sau manh mối) → bot chờ hội thoại ngớt 60 giây → gửi GLM các tin trong 3 giờ gần nhất (kèm giờ gửi thật, người gửi). GLM ghép manh mối rải rác thành **một** việc, chỉ lấy hẹn **đã chốt**, đổi giờ thì lấy phương án sau cùng, bị huỷ thì bỏ.
   VD: "Thứ 7 rảnh không?" → "Rảnh" → "Highlands 9h nhé" → "Ok" ⇒ *09:00 thứ Bảy — Đi cà phê với Hùng (Highlands)*.
   "Mai", "tối nay"... tính theo **ngày gửi** của tin (tin từ hôm trước được ghi chú sẵn ngày cụ thể).
   Việc trùng với việc AI phân tích tin đã tạo (cùng đoạn chat + cùng giờ, hoặc tên gần giống) bị bỏ.
   **Đổi giờ / đổi chỗ / huỷ hẹn:** GLM được xem các việc bot đã ghi từ đoạn chat đó. Hội thoại chốt đổi giờ, ngày hay địa điểm → bot **sửa** việc cũ (ghi chú "🔁 Đổi lịch: cũ → mới", mốc nhắc tính lại theo giờ mới). Hội thoại huỷ hoặc hoãn chưa có ngày → việc chuyển sang đã xong với tiền tố **"❌ Huỷ:"** và lý do (không xoá, không nhắc nữa). Đề nghị đổi mà chưa ai đồng ý thì giữ nguyên. Việc tạo tay không bao giờ bị sửa. Tin chỉ có "huỷ / hoãn / dời / đổi / thôi / bận" cũng làm bot xét lại, nếu đoạn chat đang có việc bot đã ghi. Chỉnh trong `autoSchedule`: `conversationQuietSeconds`, `conversationWindowMinutes`, `conversationMaxMessages`.
6. Việc tìm được thành **công việc** (nhãn 📎 / 🖼️) trên Lịch, và thêm vào lịch của Yuyuko. Việc đã có (cùng tên bỏ dấu + cùng hạn) thì không tạo lại.
7. **Nhắc giờ** cho mọi việc chưa xong có hạn: trước 1 ngày, trước 1 tiếng, đúng giờ. Việc cả ngày được nhắc 20:00 hôm trước và 07:00 sáng hôm đó. Nhắc trên giao diện (thông báo + chuông) và Yuyuko (bong bóng + tiếng kêu).

Bot không tự tải được file (chat đang đóng: bot chỉ thấy dòng xem trước, và không tự mở chat để khỏi báo "đã xem")? Thì:
- bấm tải file trong trình duyệt của bot, hoặc
- lưu file (giữ nguyên tên) vào `data/hop_file/`. Bot tự đọc và ghép với tin nhắn đi kèm.

Cấu hình:
- `.env`: `YUYUKO_DIR` = thư mục chứa `shimeji.exe` (hộp thư `yuyuko_hop_thu.jsonl`), `OCR_SERVER_URL`.
- `config/config.json` → `autoSchedule` (model, giờ chờ gom tin, độ chắc tối thiểu, giới hạn lượt/giờ, `provider` để chọn/loại nhà cung cấp trên OpenRouter, VD `{"ignore": ["OpenInference"]}`...) và `reminders` (mốc nhắc, giờ nhắc việc cả ngày, bật/tắt Yuyuko).
- Key OpenRouter: dùng chung key ở **Cài đặt**. Chưa có thì dùng `openrouter_key` trong `config.json` của Yuyuko.
- Đọc pdf/docx/xlsx cần Python có `pypdf`, `python-docx`, `openpyxl`.

```bash
npm run thu-lich -- "duong/dan/file.pdf" --nguoi "Cô Lan" --nhom "Lớp 10A1" --truoc "Cô gửi lịch thi"
```
(Lệnh trên chỉ in kết quả GLM; thêm `--luu` để tạo công việc thật.)

```bash
npm run thu-yuyuko
```
(Mở Yuyuko trước, rồi chạy lệnh này để kiểm tra bong bóng.)

**Chat với chính mình** ("My Documents" / "Cloud của tôi") không bị tính là "tin do chính tôi gửi". Vì vậy VIP "My Documents" báo động được khi bạn nhắn vào đó từ điện thoại, và ghi chú kiểu "mai 9h khám răng" ở đó cũng được lên lịch.

Zalo đổi giao diện làm bot không bắt được tin nữa? Tắt bot rồi chạy `npm run soi-zalo`. Công cụ chỉ ghi khung trang (thẻ, class, nút; chữ trong tin bị che), chỉ mở My Documents. Kết quả nằm trong `logs/soi_zalo/`, đem so với bộ chọn `SEL` trong `src/listener.js`.

---

## 🛡️ Chống báo nhầm tin cũ

1. Lúc khởi động / Zalo tải lại trang: mọi tin hiện có chỉ được **ghi nhớ**, bot chỉ bắt đầu báo khi danh sách đã ổn định.
2. Mở / chuyển đoạn chat, hoặc nhiều tin hiện ra cùng lúc → coi là lịch sử.
3. Danh sách hội thoại: chỉ tin có nhãn "Vài giây" / "1–2 phút" mới là tin mới.
4. Khung chat: tin nằm dưới thanh ngày khác "Hôm nay", hoặc có giờ gửi (HH:mm) đã qua quá 3 phút → tin cũ.
   Tin được chèn lên **trên** tin đã có (cuộn lên xem lịch sử, Zalo tải thêm tin cũ) → tin cũ; tin mới thật luôn nối vào cuối khung chat.
   **Giờ gửi thật** của từng tin (id khung tin `bb_msg_id_<lúc gửi>` và dữ liệu tin `serverTime`/`sendDttm` của Zalo) đã qua quá 5 phút → tin cũ. Zalo chỉ hiện giờ ở tin cuối mỗi chuỗi, nhưng bot đọc được giờ của mọi tin.
5. Tin đã thấy được nhớ **24 giờ** trong `data/seen-messages.json` → khởi động lại bot không báo lại tin cũ.

---

## 🔒 Bảo mật

- Giao diện chỉ mở trên `127.0.0.1` (máy khác trong mạng LAN không truy cập được).
- Chặn DNS rebinding (kiểm tra Host), chặn CSRF (cookie SameSite=Strict, kiểm tra Origin, chỉ nhận JSON), CSP chặn script lạ.
- API key lưu trong `data/secrets.json` (đã nằm trong `.gitignore`), giao diện chỉ thấy bản che.
- Nội dung tin nhắn luôn được hiển thị dạng chữ thuần, không thể chèn mã vào giao diện.

---

## 📁 Cấu trúc thư mục

```
zalobot/
├── start-zalobot.bat / quet-qr.bat / mo-giao-dien.bat
├── config/config.json   # Từ khóa, VIP, cooldown, khung giờ, AI (sửa được trong giao diện)
├── data/                # (tự tạo) secrets, công việc, lịch sử, tin đã thấy, mốc đã nhắc, file tải về, hop_file/ — không commit
├── logs/                # app.log, alerts.log
├── public/              # Giao diện: index.html, app.js, style.css
├── src/
│   ├── index.js         # Điểm khởi chạy: giao diện + Zalo Web + tự kết nối lại
│   ├── browser.js, auth.js
│   ├── listener.js      # Bắt tin nhắn mới, lọc tin cũ (bộ chọn soi trên Zalo Web thật)
│   ├── filter.js        # Bộ lọc từ khóa / VIP / cooldown / khung giờ
│   ├── ai.js            # OpenRouter
│   ├── pipeline.js      # Tin nhắn → bộ lọc → AI → công việc → báo động
│   ├── alerter.js       # Còi máy tính + đẩy cảnh báo lên giao diện
│   ├── tasks.js, history.js, store.js, config.js, bus.js
│   ├── autoplan.js      # Lịch tự động: file / ảnh / tin → GLM → công việc
│   ├── planner.js, llm.js  # Câu hỏi GLM + gọi OpenRouter (JSON theo khuôn)
│   ├── docs.js, ocr.js  # Trích chữ file (tools/doc_text.py) + OCR Trạm 1
│   ├── dates.js, filecard.js, lich.js  # Dò ngày giờ, đọc thẻ file, chuẩn hoá hạn chót
│   ├── reminders.js     # Nhắc giờ mọi công việc → giao diện + Yuyuko
│   ├── yuyuko.js        # Hộp thư sang Yuyuko (yuyuko_hop_thu.jsonl)
│   └── server.js        # Máy chủ giao diện (127.0.0.1)
├── tools/               # doc_text.py, soi_zalo.mjs, thu_lich.js, thu_yuyuko.js
└── test/                # filter, app, dates, filecard, lich, docs, listener (trang mẫu zalo_mau.html)
```
