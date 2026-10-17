# Chấm công tăng ca

Ứng dụng web báo tăng ca cho công nhân (dùng trên điện thoại) và bảng công cho quản đốc, xuất file Excel đúng mẫu `Mau_chi_tiet_tang_ca_10_2026`.

## Cách dùng
- **Công nhân:** mở đường dẫn/quét mã QR, đăng nhập bằng tên đăng nhập + mật khẩu được cấp, chọn ca làm (Sáng / Trưa / Tối), bấm lưu. Có thể xem và sửa lại ở tab "Lịch sử đã gửi".
- **Quản đốc (Admin):** đăng nhập `admin` (mật khẩu mặc định `admin123` — **hãy đổi ngay** bằng nút "Đổi mật khẩu Admin"). Có bảng công theo ngày (X+giờ), chốt công, thêm/sửa/xóa dòng, quản lý nhân sự, sao lưu/khôi phục và xuất Excel.

## Nhân viên mới, nghỉ việc, ngày nghỉ
- **Nhân viên mới:** Admin → "Nhân sự & Tài khoản" → thêm tên, tên đăng nhập, mật khẩu và ngày vào làm. Lần đăng nhập đầu, app nhắc công nhân đổi mật khẩu mặc định.
- **Nghỉ việc:** bấm "Cho nghỉ việc" và nhập ngày làm cuối. Tài khoản bị khóa, dữ liệu cũ giữ nguyên, bảng công từ ngày đó để trống. Có nút "Đi làm lại". Nút "Xóa" chỉ có với người chưa có dữ liệu.
- **Chủ nhật và ngày lễ:** không tính công X. Công nhân tích "Tôi có đi làm ngày này" rồi ghi số giờ thực tế (đủ ngày là 8h); bảng công hiện `8h`. Admin khai báo ngày lễ, nghỉ Tết ở nút "Lịch nghỉ lễ".

## Chạy trong mạng nội bộ (WiFi công ty)
Cần cài Node.js. Nhấp đúp `KHOI_CHAY_SERVER.bat`; điện thoại cùng WiFi mở địa chỉ hiển thị trong cửa sổ lệnh. Dữ liệu lưu ở `data/overtime_db.json` (file này không được đưa lên GitHub).

## Đưa lên GitHub Pages
Đẩy code lên nhánh `main`; vào *Settings → Pages → Source: GitHub Actions*. Link: https://tongducduy03.github.io/Chamcongpx/
Lưu ý: bản GitHub Pages không có máy chủ riêng, dữ liệu lưu trên từng trình duyệt trừ khi kết nối Supabase (xem tab "Mã QR & Kết nối", file `SUPABASE_SECURITY_RLS.sql`).

## Bảo mật
Đăng nhập chạy phía trình duyệt nên chỉ phù hợp mạng nội bộ/độ nhạy thấp. Không dùng mật khẩu quan trọng của nhân viên ở đây.
