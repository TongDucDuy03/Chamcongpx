# Chấm công tăng ca

Ứng dụng web báo tăng ca cho công nhân (dùng trên điện thoại) và bảng công cho quản đốc, xuất file Excel đúng mẫu `Mau_chi_tiet_tang_ca`.

Web đang chạy tại: https://tongducduy03.github.io/Chamcongpx/

## Cách dùng

**Công nhân** — mở link quản đốc gửi qua Zalo, đăng nhập bằng tên đăng nhập + mật khẩu quản đốc cấp (lần đầu đăng nhập sẽ được nhắc đổi mật khẩu).
- *Báo tăng ca*: chọn ngày (Hôm nay / Hôm qua), chọn mẫu ca, chọn nội dung việc, bấm Lưu.
- *Bảng công*: xem cả tháng, mỗi ngày là `X`, `X+1`, `X+4`... và tổng giờ tăng ca. Bấm vào một ngày để xem hoặc sửa.
- Chủ nhật và ngày lễ: chỉ báo nếu có đi làm, ghi đúng số giờ (đủ ngày là 8 giờ).
- Mất mạng thì dữ liệu được giữ trên điện thoại và tự gửi khi có mạng.

**Quản đốc (admin)** — đăng nhập bằng tên `admin`.
- *Bảng công & Xuất Excel*: bảng công cả tháng, chọn tháng ở ô "Tháng", chốt công từng ngày, thêm/sửa/xóa ca, xuất Excel của tháng đang chọn. Công nhân sửa sau khi đã chốt thì ô được bôi vàng.
- *Nhân sự & Tài khoản*: thêm nhân viên (mật khẩu ban đầu do bạn đặt, nhân viên phải đổi lần đầu), đặt lại mật khẩu, cho nghỉ việc / đi làm lại. Mật khẩu được băm, không ai xem lại được, chỉ đặt lại.
- *Lịch nghỉ lễ*: khai báo ngày lễ, nghỉ Tết.
- *Sao lưu / Nhập file*: sao lưu 400 ngày gần nhất ra file JSON (không có mật khẩu), nhập lại khi cần.

## Cài đặt lưu dữ liệu dùng chung (Supabase) — làm 1 lần

Khi chưa cài đặt, ứng dụng chạy chế độ thử: dữ liệu chỉ nằm trong trình duyệt của từng máy. Để công nhân báo ở bất kỳ đâu và quản đốc thấy ngay, làm 4 bước:

1. Tạo project miễn phí trên https://supabase.com (chọn vùng **Southeast Asia (Singapore)**).
2. Vào **SQL Editor** → **New query**, dán toàn bộ file `supabase_setup.sql` → **Run**. Chạy lại nhiều lần vẫn an toàn.
3. Trong SQL Editor chạy: `select ot.bootstrap_admin('mật-khẩu-admin-của-bạn');` (tối thiểu 6 ký tự). Quên mật khẩu admin thì chạy `select ot.reset_admin_password('mật-khẩu-mới');`.
4. Mở file `config.js`, điền **Project URL** và khóa **Publishable** (Project Settings → API Keys), rồi đẩy lên GitHub. Chỉ dán khóa Publishable/anon, **không bao giờ dán khóa secret / service_role**.

Đẩy lên GitHub: vào *Settings → Pages → Source: GitHub Actions*; mỗi lần đẩy code lên nhánh `main`, web tự cập nhật sau khoảng 1 phút.

## Bot Telegram nhắc Quản đốc (tùy chọn) — làm 1 lần

Mỗi ngày lúc 14:00, bot gửi vào Telegram danh sách công nhân đang làm việc mà **ngày hôm trước chưa có ca tăng ca nào**, để Quản đốc đi nhắc. Người hôm đó không tăng ca thật cũng có tên, Quản đốc tự bỏ qua. Hôm trước là Chủ nhật hoặc ngày lễ (trong *Lịch nghỉ lễ*) thì bot không nhắc. Bot chạy ngay trong Supabase, không cần máy nào bật.

1. **Tạo bot**: trong Telegram tìm **@BotFather** → gửi `/newbot` → đặt tên → BotFather gửi lại **TOKEN** dạng `123456789:AAH...`. Giữ bí mật token này, không dán vào `config.js` hay gửi cho ai.
2. **Chọn nơi nhận tin**:
   - Gửi riêng cho Quản đốc: Quản đốc mở bot vừa tạo, bấm **Start**.
   - Gửi vào nhóm: thêm bot vào nhóm Quản đốc, rồi gửi trong nhóm `/start@ten_bot`.
3. **Lấy CHAT_ID**: mở trình duyệt vào `https://api.telegram.org/bot<TOKEN>/getUpdates` (thay `<TOKEN>`), tìm đoạn `"chat":{"id":...}`. Chat riêng là số dương, nhóm là số âm (ví dụ `-1001234567890`). Nếu thấy `"result":[]` thì gửi lại `/start` rồi tải lại trang.
4. Supabase → **SQL Editor** → **New query**, dán toàn bộ file `telegram_nhac_cham_cong.sql` → **Run**. Nếu báo cần bật `pg_net` / `pg_cron` thì vào *Database → Extensions* bật lên rồi chạy lại.
5. Trong SQL Editor chạy (thay token và chat id của bạn):
   `select ot.telegram_setup('TOKEN', 'CHAT_ID');`
6. Gửi thử ngay: `select ot.telegram_test();` → vài giây sau Telegram nhận tin `[Gửi thử]`. Không thấy tin thì chạy `select ot.telegram_check();` để xem lý do (sai token, sai chat id, bot bị chặn...).

Đổi giờ nhắc: `select ot.telegram_set_time('15:30');` (giờ Việt Nam). Tắt nhắc: `select ot.telegram_off();`. Đổi token / nơi nhận: chạy lại bước 5.

## Bảo mật

- Mọi bảng dữ liệu nằm trong schema riêng `ot`, không mở ra ngoài API. Trình duyệt chỉ gọi được 6 hàm `app_*` (đăng nhập, đăng xuất, đổi mật khẩu, tải, hỏi nhanh có gì mới, lưu), mỗi hàm tự kiểm tra phiên đăng nhập.
- Mật khẩu băm bcrypt; sai 5 lần liên tiếp thì khóa 15 phút; phiên công nhân 30 ngày, phiên quản trị 12 giờ.
- Công nhân chỉ đọc/ghi được dữ liệu của chính mình, không báo được ngày chưa tới, không báo cho người khác, không thấy dữ liệu người khác.
- Máy chủ kiểm tra lại mọi thứ (trùng giờ, ngày vào làm/nghỉ việc, định dạng...) nên dù ai đó sửa mã trên trình duyệt cũng không vượt được.
- Nhiều người báo cùng lúc không mất dữ liệu vì mỗi lần Lưu chỉ gửi đúng các dòng thay đổi.
- Tiết kiệm lưu lượng: máy quản trị cứ 30 giây hỏi nhanh "có gì mới không" (vài chục byte), chỉ tải lại dữ liệu khi có thay đổi.

## Lưu ý vận hành

- Gói Supabase miễn phí **tự tạm dừng nếu 7 ngày không có ai truy cập** (vào dashboard bấm Restore là chạy lại, dữ liệu vẫn còn) và **không có sao lưu tự động**: hãy bấm *Sao lưu* định kỳ (ví dụ cuối mỗi tháng) và cất file JSON.
- File Excel xuất ra theo mẫu `Mẫu chi tiết tăng ca MM_YYYY.xlsx`, mỗi lần một tháng.

## Chạy thử trong mạng nội bộ (không dùng Supabase)

Cần cài Node.js. Nhấp đúp `KHOI_CHAY_SERVER.bat`, điện thoại cùng WiFi mở địa chỉ hiển thị trong cửa sổ lệnh. Chế độ này chỉ để thử/dùng tạm một máy; nhiều người báo cùng lúc có thể ghi đè dữ liệu của nhau. Muốn dùng thật hãy cài Supabase như trên.

## Các file chính

| File | Vai trò |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | Giao diện và logic |
| `remote.js` | Lớp kết nối Supabase (gửi từng dòng thay đổi) |
| `config.js` | Địa chỉ project + khóa Publishable |
| `supabase_setup.sql` | Cài đặt cơ sở dữ liệu và bảo mật |
| `telegram_nhac_cham_cong.sql` | Bot Telegram nhắc Quản đốc ai chưa báo tăng ca hôm trước |
| `server.js`, `KHOI_CHAY_SERVER.bat` | Máy chủ thử trong mạng nội bộ |
| `Mau_chi_tiet_tang_ca_10_2026_GOC.xlsx` | File Excel mẫu gốc |
