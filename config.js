// Cấu hình kết nối Supabase (dữ liệu dùng chung cho cả xưởng).
//
// Hai giá trị dưới đây được phép công khai: đó là địa chỉ project và khóa "Publishable" (hoặc "anon").
// Bảo mật nằm ở file supabase_setup.sql: trình duyệt chỉ gọi được vài hàm đăng nhập/lưu, không đọc được bảng nào.
// TUYỆT ĐỐI KHÔNG dán khóa "secret" hoặc "service_role" vào đây.
//
// Để trống hai giá trị này thì ứng dụng chạy chế độ thử (dữ liệu chỉ lưu trong trình duyệt).
window.APP_CONFIG = {
  supabaseUrl: 'https://xjfmjjqqbwuasaiyagox.supabase.co',
  supabaseKey: 'sb_publishable_51LyoivshFZQ5W1WJK7_fA_lHDCA3Wa'
};
