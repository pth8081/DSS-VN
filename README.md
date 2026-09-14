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

**Các giai đoạn sau (CHƯA triển khai — xem lộ trình Mục 14 tài liệu thiết kế):**
Đại lý, Khách hàng dự án, Bán hàng đa kênh, Ma trận phê duyệt, Công nợ đại lý +
API kế toán, Hợp đồng & Thanh toán, CRM/Đội Sale, Báo cáo tổng hợp.

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
│   └── system.js           # Nhật ký hệ thống, Cấu hình chung
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
