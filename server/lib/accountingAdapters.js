// Kiến trúc API kế toán độc lập nhà cung cấp (Adapter Pattern — Mục 8.2 tài
// liệu thiết kế): AccountingSyncQueue là hàng đợi trung gian giữ dữ liệu dạng
// chuẩn hoá (canonical); đổi/thêm phần mềm kế toán sau này chỉ cần viết thêm
// 1 class Adapter, không sửa lại luồng nghiệp vụ Bán hàng/Công nợ đã chạy ổn định.

class AccountingAdapter {
  // eslint-disable-next-line no-unused-vars
  async pushInvoice(canonicalInvoice) { throw new Error('Chưa cài đặt adapter cụ thể'); }
  // eslint-disable-next-line no-unused-vars
  async pushPaymentQuery(dealerCode) { throw new Error('Chưa cài đặt adapter cụ thể'); }
}

// Fallback AN TOÀN khi CHƯA xác định phần mềm kế toán (Mục 15.2) — không chờ
// xác nhận mới bắt đầu code module Công nợ. Không tự gửi gì cả; hoá đơn nằm
// trong AccountingSyncQueue tới khi admin bấm "Xuất CSV" (routes/finance.js)
// để kế toán tự nhập tay, không chặn tiến độ luồng bán hàng.
class ExcelExportAdapter extends AccountingAdapter {
  async pushInvoice() { /* xử lý dạng batch qua endpoint xuất CSV, không push từng hoá đơn 1 */ }
  async pushPaymentQuery() { /* không áp dụng — xác nhận thanh toán đi ngược lại qua /api/external/payment-confirmations */ }
}

// Ví dụ khi đã xác định dùng MISA (API thật) — cắm vào khi có thông tin chính
// thức (endpoint, App ID, Access Token...), không sửa gì ở routes/finance.js.
class MisaAdapter extends AccountingAdapter {
  async pushInvoice() { throw new Error('Chưa cấu hình MISA AMIS OpenAPI — xem HUONG_DAN_DEPLOY_UBUNTU.md'); }
  async pushPaymentQuery() { throw new Error('Chưa cấu hình MISA AMIS OpenAPI — xem HUONG_DAN_DEPLOY_UBUNTU.md'); }
}

function getActiveAdapter() {
  return new ExcelExportAdapter();
}

module.exports = { AccountingAdapter, ExcelExportAdapter, MisaAdapter, getActiveAdapter };
