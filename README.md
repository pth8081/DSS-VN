# DSS-VN — Nền tảng Quản trị Vận hành Phân phối CNTT

Node.js (Express) + SQL Server (MSSQL). Xem đầy đủ phân tích nghiệp vụ & thiết
kế hệ thống (kiến trúc tổng thể, tất cả các module, quyết định thiết kế) ở tài
liệu gốc đã cung cấp: `thiet_ke_he_thong_phan_phoi_cntt.md`.

## Trạng thái triển khai

**Giai đoạn 1 — Nền tảng (ĐÃ CÓ trong code):**
- Danh mục nền tảng: Nhóm sản phẩm, Sản phẩm, Kho, Bảng giá, Hạng đại lý, Khu vực
- Kho hàng: tồn kho thực tế/đã giữ/khả dụng theo đúng 3 con số riêng biệt,
  nhập kho, điều chỉnh kiểm kê, chuyển kho, lịch sử giao dịch — mọi thay đổi
  đi qua stored procedure có khoá dòng (chặn ở CSDL, không chỉ ở tầng ứng dụng)
- Hệ thống cơ bản: Vị trí (seat-based) & Nhân viên, Tài khoản & Phân quyền,
  Nhật ký hệ thống, Cấu hình chung

**Giai đoạn 2 — Khách hàng & Bán hàng (ĐÃ CÓ trong code):**
- Đại lý: hồ sơ đại lý, hạng đại lý + hạn mức/số ngày công nợ (mặc định theo
  hạng hoặc override riêng — tách quyền `dealerManage` vs `dealerCreditOverride`
  vì đây là quyền hạn chế), lịch sử xét duyệt hạn mức, danh sách đại lý đủ
  điều kiện xét tăng hạn mức (onboard ≥ 3 tháng)
- Khách hàng dự án: hồ sơ dự án theo giai đoạn (Lead→...→Closed), báo giá
  nhiều phiên bản
- Bán hàng đa kênh: kênh bán hàng (Website/Cổng đại lý/Sale trực tiếp — mỗi
  kênh 1 thời gian giữ hàng mặc định riêng), tạo đơn (NHÁP) → thêm dòng hàng
  (tự tra giá theo đúng hạng đại lý, 1 nguồn giá duy nhất cho mọi kênh) → gửi
  duyệt (giữ hàng thật qua `ReserveStock`) → hủy (nhả hàng qua `ReleaseStock`);
  cron quét mỗi giờ tự hủy đơn CHỜ DUYỆT quá hạn giữ hàng
  (`server/jobs/expireReservations.js`)

**Giai đoạn 3 — Kiểm soát (ĐÃ CÓ trong code):**
- Ma trận phê duyệt bán hàng: gửi duyệt tự tính `evaluateIsStandardDeal` ngay
  tại server (giá bán vs bảng giá, hạn mức công nợ hiệu lực trừ công nợ hiện
  tại thật từ `DealerLedger`, số ngày công nợ) → tra `ApprovalMatrixRules`
  đúng loại (CHUẨN/vượt hạn mức/vượt chiết khấu/cả 2) → sinh các bước duyệt
  seat-based (engine dùng chung `ApprovalInstances`/`ApprovalSteps`, không
  viết riêng cho Bán hàng). Duyệt/từ chối kiểm tra đúng người giữ đúng vị trí
  ở đúng bước (không cho duyệt vượt bước) + quyền `salesApproveStandard`/
  `salesApproveException`. Từ chối ở bất kỳ bước nào → hủy đơn + nhả tồn kho
  ngay. Retail (B2C) trả trước bỏ qua ma trận, tự động ĐÃ DUYỆT.
- Công nợ đại lý: sổ cái `DealerLedger` **append-only thật sự ở CSDL** (trigger
  chặn UPDATE/DELETE), đơn ĐÃ DUYỆT → "Xuất kho" phát sinh hoá đơn công nợ +
  xuất kho thật (`ExportSoldStock`/`FulfillSalesOrder`) trong cùng 1 giao dịch.
  Cảnh báo tự động vượt hạn mức ngay trên danh sách đại lý.
- API kế toán dạng Adapter (Mục 8.2): hàng đợi trung gian `AccountingSyncQueue`
  + `server/lib/accountingAdapters.js` (interface `AccountingAdapter`, mặc
  định `ExcelExportAdapter` — xuất CSV cho kế toán tự nhập tay, chưa xác nhận
  phần mềm kế toán thật thì dùng tạm, đổi sau không ảnh hưởng luồng bán hàng).
  Chiều ngược lại: `POST /api/external/payment-confirmations` (X-API-Key +
  allowlist IP tuỳ chọn + rate limit + ghi log mọi lượt gọi).
- **Giới hạn/quyết định thiết kế cần biết**: đơn Khách hàng dự án (không gắn
  Đại lý cụ thể) luôn coi là CHUẨN (1 cấp duyệt) vì Module 5 chưa có khái
  niệm hạn mức/hạng như Đại lý — xem lại nếu nghiệp vụ thực tế cần khác.
  `MisaAdapter` mới là stub — cắm API thật khi xác nhận phần mềm kế toán.

**Giai đoạn 4 — Hợp đồng & Thanh toán, CRM (ĐÃ CÓ trong code):**
- Hợp đồng: 2 loại (Khung với Đại lý — hiệu lực dài hạn, không theo từng đơn
  hàng; Theo Dự án — 1 hợp đồng/1 dự án) + phụ lục thanh toán theo giai đoạn
  (tạm ứng/nghiệm thu/quyết toán). Thanh toán tách 2 bước: "Duyệt chi" (xác
  nhận nội bộ phụ lục hợp lệ, quyền `contractManage`) → "Xác nhận đã thu tiền"
  (quyền `reportViewFinance`, tách biệt người duyệt khỏi người xác nhận tiền
  — chỉ bước này mới ghi nhận vào `DealerLedger` nếu hợp đồng gắn Đại lý).
- CRM: ghi nhận tương tác khách hàng (gọi điện/gặp mặt/email/thăm khách hàng)
  theo Đại lý hoặc Dự án. Đổi Sale phụ trách ở Đại lý/Dự án nay giữ lịch sử
  (`DealerSalesAssignmentHistory`/`ProjectSalesAssignmentHistory`, cùng mô
  hình `EmployeePositionHistory`) — chuẩn bị dữ liệu cho báo cáo doanh số
  Giai đoạn 5 tính đúng theo người phụ trách tại đúng thời điểm phát sinh,
  không tính nhầm cho người mới nhận bàn giao sau này.
- **Giới hạn**: hợp đồng Dự án không gắn Đại lý thì phụ lục xác nhận thu tiền
  chỉ đổi trạng thái, chưa có sổ cái riêng cho Dự án (tương tự giới hạn đã
  nêu ở Giai đoạn 3 cho đơn hàng Dự án).

**Các giai đoạn sau (CHƯA triển khai — xem lộ trình Mục 14 tài liệu thiết kế):**
Báo cáo tổng hợp.

## Cấu trúc thư mục

```
server/
├── server.js              # Điểm khởi chạy chính (Express app)
├── db.js                  # Kết nối SQL Server (connection pool)
├── middleware/auth.js      # Xác thực JWT cookie + kiểm tra quyền (PermsJson)
├── routes/
│   ├── auth.js             # POST /api/auth/login, /logout, GET /me
│   ├── employees.js        # Vị trí, Nhân viên, Tài khoản người dùng
│   ├── catalog.js          # Nhóm sản phẩm, Sản phẩm, Kho, Bảng giá, Hạng đại lý, Khu vực
│   ├── inventory.js        # Tồn kho, nhập/điều chỉnh/chuyển kho, lịch sử giao dịch
│   ├── system.js           # Nhật ký hệ thống, Cấu hình chung
│   ├── dealers.js          # Đại lý, hạn mức/công nợ, lịch sử xét duyệt hạn mức, sổ cái
│   ├── projects.js         # Khách hàng dự án, báo giá
│   ├── sales.js            # Kênh bán hàng, đơn hàng đa kênh, phê duyệt, xuất kho/công nợ
│   ├── finance.js          # Hàng đợi đồng bộ kế toán, xuất CSV
│   ├── external.js         # API kế toán ngoài (xác nhận thanh toán, X-API-Key)
│   ├── contracts.js        # Hợp đồng, phụ lục thanh toán, Duyệt chi/Xác nhận thu tiền
│   └── crm.js              # Tương tác khách hàng (Đội Sale)
├── lib/
│   └── accountingAdapters.js   # Adapter Pattern kế toán (ExcelExportAdapter mặc định)
├── jobs/
│   └── expireReservations.js   # Cron giờ: tự hủy đơn CHỜ DUYỆT quá hạn giữ hàng
├── sql/
│   └── schema.sql          # Script tạo database + toàn bộ bảng/stored procedure + seed mặc định
├── public/
│   └── index.html          # Frontend (đăng nhập + quản lý danh mục/kho/nhân sự)
├── package.json
├── .env.example            # Copy thành .env và điền thông tin SQL Server thật
└── .gitignore
```

## Chạy nhanh (xem chi tiết trong HUONG_DAN_DEPLOY_UBUNTU.md)

```bash
cd server
npm install
cp .env.example .env   # rồi sửa thông tin kết nối SQL Server + JWT_SECRET trong .env
sqlcmd -S <server> -U sa -P <password> -i sql/schema.sql
npm start
```

Mở trình duyệt: http://localhost:3000

Tài khoản mặc định: `admin / 123456` — đổi ngay sau khi triển khai thật (xem
mục 7 của `HUONG_DAN_DEPLOY_UBUNTU.md`).

## Nguyên tắc thiết kế xuyên suốt (áp dụng cho mọi giai đoạn)

1. **Seat-based** — người duyệt/phụ trách gán theo Vị trí, không gán cứng
   theo tên người (bảng `Positions` + `Employees` + `EmployeePositionHistory`).
2. **Zero Trust** — số liệu quyết định (quyền, tồn kho khả dụng) server tự
   tính lại tại thời điểm xử lý, không tin dữ liệu client gửi lên hay nhúng
   sẵn trong JWT.
3. **Chặn ở CSDL** — ràng buộc tồn kho dùng khoá dòng (`UPDLOCK`/`ROWLOCK`
   trong stored procedure), không chỉ kiểm tra ở tầng ứng dụng.
4. **Cấu hình được, không hardcode** — chính sách (hạn mức, % chiết khấu,
   ngưỡng...) là dữ liệu trong `dbo.AppConfig`/bảng cấu hình, không hardcode
   trong code.

Xem đầy đủ hướng dẫn triển khai tại `HUONG_DAN_DEPLOY_UBUNTU.md`.
