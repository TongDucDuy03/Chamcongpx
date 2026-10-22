# Chấm công tăng ca

Ứng dụng web báo tăng ca cho công nhân (dùng trên điện thoại) và bảng công cho quản đốc, xuất file Excel đúng mẫu `Mau_chi_tiet_tang_ca`.

Web đang chạy tại: https://tongducduy03.github.io/Chamcongpx/

## Cách dùng

**Công nhân** — mở link quản đốc gửi qua Zalo, đăng nhập bằng tên đăng nhập + mật khẩu quản đốc cấp (lần đầu đăng nhập sẽ được nhắc đổi mật khẩu).
- *Báo tăng ca*: chọn ngày (Hôm nay / Hôm qua), chọn mẫu ca, chọn nội dung việc, bấm Lưu.
- *Nghỉ / về sớm* (mục 2 của form, báo cùng lúc với tăng ca): Nghỉ sáng / Nghỉ chiều → `X/2`, Nghỉ cả ngày → `P`, về sớm (hoặc đi muộn) 1 giờ → `-1`. Ví dụ nghỉ sáng, tối tăng ca 1 giờ là `X/2+1`; sáng tăng ca 1 giờ, chiều về sớm 1 giờ là `X+1-1`. Về sớm ghi riêng, không trừ vào giờ tăng ca, và không đưa vào file Excel tăng ca.
- *Bảng công*: xem cả tháng, mỗi ngày là `X`, `X+1`, `X+4`... và tổng giờ tăng ca. Bấm vào một ngày để xem hoặc sửa.
- Chủ nhật và ngày lễ: chỉ báo nếu có đi làm. Nhập giờ bắt đầu/kết thúc và **Số giờ làm thực tế**: 07:15–17:15 nghỉ trưa 2 giờ thì nhập **8**, làm xuyên trưa thì nhập **10**. Để trống số giờ để tính theo khoảng giờ; khi đổi giờ bắt đầu/kết thúc, số giờ tự chỉnh được xóa để tính lại. Nút **Đủ ngày (8 giờ)** chọn 07:15–17:15 với 8 giờ thực tế. Bảng công và Excel dùng số giờ thực tế đã lưu.
- Mất mạng thì dữ liệu được giữ trên điện thoại và tự gửi khi có mạng.

**Quản đốc (admin)** — đăng nhập bằng tên `admin`.
- *Bảng công & Xuất Excel*: bảng công cả tháng, chọn tháng ở ô "Tháng", chốt công từng ngày, thêm/sửa/xóa ca, xuất Excel của tháng đang chọn (chọn ô "Ngày" trên thanh lọc thì chỉ xem và xuất các ca của ngày đó). Công nhân sửa sau khi đã chốt thì ô được bôi vàng.
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

Khi cập nhật tính năng sửa giờ làm Chủ nhật/ngày lễ: chạy lại `supabase_setup.sql` trên Supabase trước khi phát hành giao diện mới, rồi tải lại trang. Phiên bản máy chủ cũ chưa cho công nhân lưu số giờ tự chỉnh; giao diện sẽ báo cần cập nhật để tránh lưu sai giờ.

**Thứ tự khi nâng cấp lên bản có phân quyền theo tài khoản + Telegram theo tài khoản** (làm đúng thứ tự):
1. Đẩy giao diện mới lên GitHub (web tự cập nhật sau khoảng 1 phút). Giao diện mới chạy được với máy chủ cũ (mặc định mọi người là Công nhân, có chấm công).
2. Chạy lại `supabase_setup.sql` trong SQL Editor (chạy lại nhiều lần vẫn an toàn). Lần đầu tiên nó thêm các cột mới và đặt tài khoản Admin sẵn có thành **không chấm công cá nhân** + **nhận báo cáo quản lý**; các lần chạy sau không ghi đè giá trị đã chỉnh.
3. Chạy lại `telegram_nhac_cham_cong.sql` (giữ token, giờ nhắc). Cài đặt cũ (đã có token) được giữ nguyên, kể cả chat id nhóm/Quản đốc; tên bot tự điền `pxkhuon_bot` nên không cần chạy thêm lệnh nào (bot khác tên thì chạy `select ot.telegram_setup('TOKEN', NULL, '14:00', 'ten_bot');`).

## Tài khoản, quyền và Telegram

Mọi người (kể cả Quản đốc) dùng **tài khoản riêng** trong *Nhân sự & Tài khoản*. Mỗi tài khoản có:

- **Quyền**: *Công nhân* hoặc *Admin* (Quản đốc, vào được trang quản lý). Luôn phải còn ít nhất một Admin đang làm; Admin không tự hạ quyền / tự cho nghỉ việc / tự xóa mình; muốn xóa một Admin phải hạ quyền trước. Đổi quyền hoặc cho nghỉ việc thì người đó phải đăng nhập lại.
- **Có chấm công cá nhân**: quyết định ai có tên trong bảng công, KPI, xuất Excel, danh sách "chưa báo" (quyền Admin không quyết định điều này). Tắt thì dữ liệu cũ vẫn giữ, chỉ không ghi thêm được.
- **Nhận báo cáo quản lý** (chỉ Admin) và **Nhận thông báo cá nhân**.
- **Telegram**: người dùng bấm **Kết nối Telegram**, mở liên kết `t.me/<bot>?start=<mã>` rồi bấm *Start*; hệ thống tự lưu Chat ID (mã dùng 1 lần, hết hạn sau 15 phút). Có nút *Gửi thử* và *Ngắt liên kết*. Bấm Start với bot không cấp thêm quyền gì.
- Quên mật khẩu admin: `select ot.reset_admin_password('mật-khẩu-mới');` chỉ áp cho tài khoản có tên đăng nhập `admin` (đồng thời bỏ ngày nghỉ việc và mở khóa); Admin khác không bị đổi. Không đổi tên đăng nhập `admin`.
- Phiên đăng nhập của mọi tài khoản Admin giữ 12 giờ (token admin có toàn quyền).

## Bot Telegram (tùy chọn) — làm 1 lần

Bot chạy ngay trong Supabase, không cần máy nào bật.

- **Báo cáo quản lý** lúc 14:00 hằng ngày: gửi cho mọi Admin bật *Nhận báo cáo quản lý* và đã kết nối Telegram (cộng nhóm dùng chung nếu có cài chat id) danh sách người có chấm công mà **ngày hôm trước chưa báo gì** (không có ca tăng ca, không báo nghỉ / về sớm). Người hôm đó không tăng ca thật cũng có tên, Quản đốc tự bỏ qua. Hôm trước là Chủ nhật hoặc ngày lễ (trong *Lịch nghỉ lễ*) thì không gửi. Cuối tin có dòng "Còn N thay đổi sau chốt chưa duyệt" khi có.
- **Nhắc cá nhân**: người thiếu báo công, bật *Nhận thông báo cá nhân* và đã kết nối Telegram nhận tin riêng. Cũng nhận tin khi Quản đốc duyệt thay đổi sau chốt của mình.
- **Sửa sau chốt**: có người sửa sau khi chốt công thì Quản đốc nhận tin ngay ("trước → sau").

Cài đặt:

1. **Tạo bot**: trong Telegram tìm **@BotFather** → gửi `/newbot` → đặt tên → BotFather gửi lại **TOKEN** dạng `123456789:AAH...` và tên bot (ví dụ `pxkhuon_bot`). Giữ bí mật token này, không dán vào `config.js` hay gửi cho ai.
2. Supabase → **SQL Editor** → **New query**, dán toàn bộ file `telegram_nhac_cham_cong.sql` → **Run**. Nếu báo cần bật `pg_net` / `pg_cron` thì vào *Database → Extensions* bật lên rồi chạy lại.
3. Trong SQL Editor chạy (thay TOKEN, giữ 2 dấu nháy đơn):
   `select ot.telegram_setup('TOKEN');`
   Bot không tên `pxkhuon_bot` thì ghi tên ở tham số thứ 4: `select ot.telegram_setup('TOKEN', NULL, '14:00', 'ten_bot');`
   Có nhóm Quản đốc dùng chung thì thêm chat id nhóm (số âm, lấy ở `https://api.telegram.org/bot<TOKEN>/getUpdates`): `select ot.telegram_setup('TOKEN', 'CHAT_ID');`. Không ghi chat id (như `ot.telegram_setup('TOKEN')`) thì giữ chat id đã lưu; ghi `''` để xóa chat chung.
4. Mỗi người vào web, bấm **Kết nối Telegram** (Admin: bật thêm *Nhận báo cáo quản lý* trong *Nhân sự & Tài khoản*).
5. Gửi thử báo cáo cho mọi người nhận: `select ot.telegram_test();` → vài giây sau xem `select ot.telegram_check();` (cho biết sai token, sai chat id, bot bị chặn...).

Đổi giờ nhắc: `select ot.telegram_set_time('15:30');` (giờ Việt Nam). Tắt nhắc: `select ot.telegram_off();`. **Đổi sang token bot khác**: chạy lại `telegram_setup` với token mới; mọi người phải bấm *Kết nối Telegram* lại với bot mới. Chạy lại file `.sql` hoặc `telegram_setup` cùng token không mất liên kết nào.

## Bảo mật

- Mọi bảng dữ liệu nằm trong schema riêng `ot`, không mở ra ngoài API. Trình duyệt chỉ gọi được các hàm `app_*` (đăng nhập, đăng xuất, đổi mật khẩu, tải, hỏi nhanh có gì mới, lưu, và 4 hàm Telegram), mỗi hàm tự kiểm tra phiên đăng nhập.
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
| `telegram_nhac_cham_cong.sql` | Bot Telegram: báo cáo cho Quản đốc, nhắc cá nhân, kết nối Telegram theo tài khoản |
| `tests/*.sql` | Kiểm thử máy chủ trên PostgreSQL cục bộ (`pg-stubs.sql` giả lập pg_net / pg_cron; xem đầu mỗi file cách chạy) |
| `server.js`, `KHOI_CHAY_SERVER.bat` | Máy chủ thử trong mạng nội bộ |
| `Mau_chi_tiet_tang_ca_10_2026_GOC.xlsx` | File Excel mẫu gốc |
