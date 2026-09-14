# TÀI LIỆU PHÂN TÍCH NGHIỆP VỤ & THIẾT KẾ HỆ THỐNG
# NỀN TẢNG QUẢN TRỊ VẬN HÀNH — PHÂN PHỐI CNTT (Distribution Operations Platform)

> Bản đã chốt phương án cho các điểm còn để ngỏ — dùng phương án tối ưu theo kinh nghiệm ngành phân phối CNTT, có thể tinh chỉnh lại khi có số liệu thực tế công ty (xem Mục 15).

---

## 0. MỤC ĐÍCH, PHẠM VI & NGUYÊN TẮC THIẾT KẾ XUYÊN SUỐT

### 0.1. Mục đích

Xây dựng 1 nền tảng duy nhất quản trị toàn bộ vòng đời kinh doanh phân phối CNTT: từ hàng nằm trong kho → bán cho đại lý/khách hàng dự án qua nhiều kênh → phê duyệt đúng chính sách → ghi nhận công nợ → thu tiền → báo cáo tổng hợp cho điều hành. Đây là **1 chuỗi nghiệp vụ liên thông** — hành động ở module này tự động kéo theo đúng thay đổi ở module khác (bán hàng → trừ kho → phát sinh công nợ → cập nhật hạn mức còn lại của đại lý).

### 0.2. Nguyên tắc thiết kế xuyên suốt

| # | Nguyên tắc | Áp dụng cụ thể |
|---|---|---|
| 1 | **Seat-based / Vị trí là gốc** | Người duyệt gán theo Vị trí, không gán cứng theo tên người |
| 2 | **Zero Trust** | Mọi số liệu quyết định (hạn mức, giá duyệt, tồn kho khả dụng) server tự tính lại tại thời điểm xử lý |
| 3 | **Tách biệt nhiệm vụ** | Người tạo đơn hàng/đề xuất không bao giờ tự duyệt chính đề xuất đó |
| 4 | **Chặn ở CSDL** | Ràng buộc tồn kho/hạn mức dùng khóa dòng, tránh 2 giao dịch cùng lúc vượt giới hạn thật |
| 5 | **Cấu hình được, không hardcode** | Chính sách giá, ma trận phê duyệt, ngưỡng hạn mức đều là dữ liệu cấu hình |
| 6 | **1 dữ liệu gốc, nhiều nơi dùng** | Thông tin đại lý/khách hàng dự án nhập 1 lần, dùng chung mọi module |

---

## 1. KIẾN TRÚC TỔNG THỂ

```
                    [Danh mục nền tảng: Sản phẩm, Kho, Đại lý, KH Dự án, Bảng giá]
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        ▼                                 ▼                                 ▼
[Kho hàng]  ◄──── trừ/giữ hàng ────  [Bán hàng đa kênh]  ──── tạo đề xuất ────► [Phê duyệt bán hàng]
   │                                       │                                       │
   │                                       ▼                                       │ (duyệt xong)
   │                              [Hợp đồng & Thanh toán]                          ▼
   │                                       │                              [Đơn hàng CHÍNH THỨC]
   │                                       ▼                                       │
   └──────────────────────────►  [Công nợ đại lý] ◄── API ──► [Phần mềm Kế toán]  │
                                           │                                       │
                                           ▼                                       ▼
                                  [Báo cáo tổng hợp] ◄──────── [CRM / Đội Sale] ◄──┘
                                           ▲
                                           │
                          [Module Hệ thống: Log, Phân quyền, Biểu mẫu, Cấu hình]
```

Nguyên tắc luồng: 1 đơn hàng đi qua đúng 3 trạng thái lớn — **NHÁP** (chưa ảnh hưởng gì) → **CHỜ DUYỆT/ĐÃ DUYỆT** (đã giữ hàng, đã kiểm tra hạn mức) → **ĐÃ XUẤT KHO** (trừ tồn kho thật, phát sinh công nợ thật). Không giai đoạn nào được phép nhảy cóc.

---

## 2. DANH MỤC NỀN TẢNG (Master Data)

```sql
CREATE TABLE dbo.ProductCategories (
    CategoryId      INT IDENTITY PRIMARY KEY,
    CategoryName    NVARCHAR(150),
    DefaultSerialTracking BIT DEFAULT 0    -- mặc định bật/tắt serial cho cả nhóm — xem quyết định Mục 15.3
);

CREATE TABLE dbo.Products (
    ProductId       INT IDENTITY PRIMARY KEY,
    SKU             NVARCHAR(50) UNIQUE NOT NULL,
    ProductName     NVARCHAR(300),
    Brand           NVARCHAR(100),
    CategoryId      INT REFERENCES dbo.ProductCategories(CategoryId),
    UnitOfMeasure   NVARCHAR(20),
    HasSerialTracking BIT NULL,             -- NULL = kế thừa DefaultSerialTracking của Category; có giá trị = override riêng SKU này
    CostingMethod   NVARCHAR(20) DEFAULT 'WEIGHTED_AVG',
    IsActive        BIT DEFAULT 1
);

CREATE TABLE dbo.Warehouses (
    WarehouseId     INT IDENTITY PRIMARY KEY,
    WarehouseCode   NVARCHAR(30) UNIQUE,
    WarehouseName   NVARCHAR(200),
    Address         NVARCHAR(300)
);

CREATE TABLE dbo.PriceLists (
    PriceListId     INT IDENTITY PRIMARY KEY,
    PriceListName   NVARCHAR(200),
    DealerTierId    INT NULL REFERENCES dbo.DealerTiers(TierId),
    EffectiveFrom   DATE, EffectiveTo DATE NULL,
    Status          NVARCHAR(20) DEFAULT 'ACTIVE'
);
CREATE TABLE dbo.PriceListItems (
    PriceListItemId INT IDENTITY PRIMARY KEY,
    PriceListId     INT NOT NULL REFERENCES dbo.PriceLists(PriceListId),
    ProductId       INT NOT NULL REFERENCES dbo.Products(ProductId),
    ListPrice       DECIMAL(18,2),
    MaxDiscountPct  DECIMAL(5,2) DEFAULT 0
);
```

---

## 3. MODULE QUẢN LÝ KHO HÀNG

### 3.1. Ba con số tồn kho — không được gộp thành 1

| Loại tồn kho | Ý nghĩa | Thay đổi khi nào |
|---|---|---|
| **Tồn kho thực tế** (`OnHandQty`) | Hàng vật lý đang trong kho | Nhập/xuất kho thật sự |
| **Tồn kho đã giữ** (`ReservedQty`) | Đã cam kết cho đơn đang chờ/đã duyệt chưa xuất | Đơn CHỜ DUYỆT → hủy/hết hạn giữ hàng |
| **Tồn kho khả dụng** (`AvailableQty`) | Số thực sự bán thêm được = `OnHandQty - ReservedQty` | Tính động |

```sql
CREATE TABLE dbo.InventoryBalances (
    ProductId       INT NOT NULL,
    WarehouseId     INT NOT NULL,
    OnHandQty       DECIMAL(18,2) NOT NULL DEFAULT 0,
    ReservedQty     DECIMAL(18,2) NOT NULL DEFAULT 0,
    AvgCost         DECIMAL(18,4),
    PRIMARY KEY (ProductId, WarehouseId)
);

CREATE TABLE dbo.InventoryTransactions (
    TransId         BIGINT IDENTITY PRIMARY KEY,
    ProductId       INT NOT NULL,
    WarehouseId     INT NOT NULL,
    TransType       NVARCHAR(30),   -- IMPORT_PO / EXPORT_SALE / TRANSFER_OUT / TRANSFER_IN / ADJUST / RETURN_IN / RETURN_OUT
    Quantity        DECIMAL(18,2),
    UnitCost        DECIMAL(18,4),
    RefType         NVARCHAR(30), RefId BIGINT,
    SerialNumbers   NVARCHAR(MAX) NULL,
    CreatedAt       DATETIME2 DEFAULT SYSUTCDATETIME()
);
```

### 3.2. Cơ chế giữ hàng (Reservation)

```sql
CREATE OR ALTER PROCEDURE dbo.ReserveStock
    @ProductId INT, @WarehouseId INT, @Qty DECIMAL(18,2), @SalesOrderId BIGINT
AS
BEGIN
    BEGIN TRANSACTION;
    DECLARE @Available DECIMAL(18,2);
    SELECT @Available = OnHandQty - ReservedQty FROM dbo.InventoryBalances WITH (UPDLOCK, ROWLOCK)
    WHERE ProductId=@ProductId AND WarehouseId=@WarehouseId;

    IF @Available < @Qty
    BEGIN
        ROLLBACK; THROW 50001, 'Không đủ tồn kho khả dụng', 1;
    END
    UPDATE dbo.InventoryBalances SET ReservedQty = ReservedQty + @Qty
    WHERE ProductId=@ProductId AND WarehouseId=@WarehouseId;
    COMMIT;
END
```

Serial Number: khi xuất kho, chọn đúng serial cụ thể → phục vụ tra cứu bảo hành/RMA theo đúng serial đã bán cho đại lý nào, ngày nào (chi tiết áp dụng — xem Mục 15.3).

---

## 4. MODULE QUẢN LÝ ĐẠI LÝ (Dealer Management)

```sql
CREATE TABLE dbo.DealerTiers (
    TierId          INT IDENTITY PRIMARY KEY,
    TierName        NVARCHAR(50),           -- Kim Cương / Vàng / Bạc / Đồng
    DefaultCreditLimit DECIMAL(18,2),
    DefaultPaymentTermDays INT,
    DefaultMaxDiscountPct DECIMAL(5,2),      -- % chiết khấu tự quyết tối đa theo hạng — xem Mục 15.1
    DisplayOrder    INT
);

CREATE TABLE dbo.Dealers (
    DealerId        INT IDENTITY PRIMARY KEY,
    DealerCode      NVARCHAR(30) UNIQUE,
    DealerName      NVARCHAR(300),
    TaxCode         NVARCHAR(20) UNIQUE,
    TierId          INT REFERENCES dbo.DealerTiers(TierId),
    CreditLimitOverride DECIMAL(18,2) NULL,
    PaymentTermDaysOverride INT NULL,
    RegionId        INT,
    AssignedSalesId INT REFERENCES dbo.Employees(EmployeeId),
    OnboardedAt     DATE,                    -- ngày trở thành đại lý — dùng tính mốc xét tăng hạn mức (Mục 15.1)
    Status          NVARCHAR(20) DEFAULT 'ACTIVE'   -- ACTIVE / SUSPENDED / BLACKLIST
);

-- Lịch sử xét duyệt hạn mức — phục vụ quy trình tăng hạn mức định kỳ (Mục 15.1)
CREATE TABLE dbo.DealerCreditReviews (
    ReviewId        INT IDENTITY PRIMARY KEY,
    DealerId        INT NOT NULL REFERENCES dbo.Dealers(DealerId),
    ReviewDate      DATE,
    OldLimit        DECIMAL(18,2),
    ProposedLimit   DECIMAL(18,2),
    OnTimePaymentRatio DECIMAL(5,2),          -- % thanh toán đúng hạn trong kỳ xét
    Decision        NVARCHAR(20),             -- APPROVED / REJECTED / DEFERRED
    ApprovedBy      NVARCHAR(100)
);
```

Đổi `TierId`/`CreditLimitOverride` phải qua phê duyệt riêng — nối vào ma trận phê duyệt Mục 7.

---

## 5. MODULE QUẢN LÝ KHÁCH HÀNG DỰ ÁN (Project Customer Management)

```sql
CREATE TABLE dbo.Projects (
    ProjectId       INT IDENTITY PRIMARY KEY,
    ProjectName     NVARCHAR(300),
    EndCustomerName NVARCHAR(300),
    EstimatedValue  DECIMAL(18,2),
    Stage           NVARCHAR(30),    -- LEAD -> QUALIFIED -> QUOTED -> NEGOTIATION -> WON -> LOST -> IMPLEMENTING -> CLOSED
    ExpectedCloseDate DATE,
    CompetitorNotes NVARCHAR(1000),
    AssignedSalesId INT REFERENCES dbo.Employees(EmployeeId),
    LostReason      NVARCHAR(300) NULL
);
CREATE TABLE dbo.ProjectQuotes (
    QuoteId         INT IDENTITY PRIMARY KEY,
    ProjectId       INT NOT NULL REFERENCES dbo.Projects(ProjectId),
    QuoteVersion    INT,
    TotalAmount     DECIMAL(18,2),
    Status          NVARCHAR(20)
);
```

Doanh thu Đại lý đo theo **tần suất mua lặp lại + tăng trưởng theo thời gian**; doanh thu Khách hàng dự án đo theo **tỷ lệ thắng thầu + giá trị trung bình/dự án** — 2 bộ chỉ số khác nhau, không dùng chung khuôn báo cáo.

---

## 6. MODULE BÁN HÀNG ĐA KÊNH (Omnichannel Sales)

```sql
CREATE TABLE dbo.SalesChannels (
    ChannelId       INT IDENTITY PRIMARY KEY,
    ChannelName     NVARCHAR(100),
    ChannelType     NVARCHAR(20),     -- DIRECT_SALES / ECOMMERCE / MARKETPLACE / DEALER_PORTAL
    DefaultReservationHours INT        -- thời gian giữ hàng mặc định theo kênh — xem Mục 15.4
);

CREATE TABLE dbo.SalesOrders (
    OrderId         BIGINT IDENTITY PRIMARY KEY,
    OrderCode       NVARCHAR(30) UNIQUE,
    OrderType       NVARCHAR(10),     -- 'B2B' / 'B2C'
    ChannelId       INT REFERENCES dbo.SalesChannels(ChannelId),
    CustomerType    NVARCHAR(20),     -- 'DEALER' / 'PROJECT' / 'RETAIL'
    DealerId        INT NULL, ProjectId INT NULL,
    WarehouseId     INT NOT NULL,
    Status          NVARCHAR(20) DEFAULT 'DRAFT',  -- DRAFT/PENDING_APPROVAL/APPROVED/FULFILLED/CANCELLED/CANCELLED_EXPIRED
    TotalAmount     DECIMAL(18,2),
    DiscountPct     DECIMAL(5,2),
    PaymentTermDays INT,
    RequiresCreditCheck BIT DEFAULT 1,    -- 0 cho Retail thanh toán trước — xem Mục 15.5
    IsStandardDeal  BIT NULL,
    ReservationExpiresAt DATETIME2 NULL,   -- Mục 15.4
    CreditCheckedAt DATETIME2 NULL, CreditAvailableAtCheck DECIMAL(18,2) NULL,
    CreatedBy       NVARCHAR(100),
    CreatedAt       DATETIME2 DEFAULT SYSUTCDATETIME()
);
```

**Nguyên tắc Omnichannel bắt buộc:** 1 nguồn tồn kho, 1 nguồn giá duy nhất cho mọi kênh — dù đơn tạo từ Website B2C hay Sale trực tiếp, đều gọi chung `ReserveStock` và tra chung `PriceListItems`. Không để mỗi kênh tự giữ 1 bản sao tồn kho/giá riêng.

---

## 7. MODULE PHÊ DUYỆT BÁN HÀNG — MA TRẬN CHUẨN / NGOẠI LỆ

### 7.1. Định nghĩa "Đơn hàng chuẩn" — tính tự động

```javascript
function evaluateIsStandardDeal(order, dealer, priceListItem) {
  if (!order.requiresCreditCheck) return { isStandard: true }; // Retail trả trước — bỏ qua thẩm định (Mục 15.5)
  const checks = {
    withinPriceList: order.unitPrice >= priceListItem.listPrice * (1 - priceListItem.maxDiscountPct/100),
    withinCreditLimit: (dealer.currentDebt + order.totalAmount) <= dealer.effectiveCreditLimit,
    standardPaymentTerm: order.paymentTermDays <= dealer.effectivePaymentTermDays,
    dealerNotSuspended: dealer.status === 'ACTIVE',
  };
  return Object.values(checks).every(Boolean) ? { isStandard: true }
                                                : { isStandard: false, failedChecks: checks };
}
```

### 7.2. Ma trận phê duyệt

| Loại đơn | Cấp duyệt | Cách gán người duyệt |
|---|---|---|
| **Chuẩn** | 1 cấp | Theo vị trí — Trưởng phòng KD phụ trách khu vực |
| **Ngoại lệ — vượt hạn mức công nợ** | 2 cấp | Trưởng phòng KD → **Giám đốc Tài chính/Kế toán trưởng** |
| **Ngoại lệ — chiết khấu vượt khung** | 2 cấp | Trưởng phòng KD → **Giám đốc Kinh doanh** |
| **Ngoại lệ — cả 2 điều kiện** | 3 cấp | Trưởng phòng KD → Giám đốc Kinh doanh → Giám đốc Tài chính |
| **Đổi hạng/hạn mức đại lý** | Riêng | Giám đốc Kinh doanh + Giám đốc Tài chính (đồng thời) |
| **Retail (B2C) trả trước** | Không qua ma trận này | Chỉ xác nhận đơn/tồn kho thông thường |

```sql
CREATE TABLE dbo.ApprovalMatrixRules (
    RuleId          INT IDENTITY PRIMARY KEY,
    ConditionType   NVARCHAR(30),    -- 'STANDARD' / 'OVER_CREDIT' / 'OVER_DISCOUNT' / 'BOTH'
    StepOrder       INT,
    ApproverMode    NVARCHAR(20),    -- 'POSITION' / 'DEPARTMENT' / 'PERSON'
    ApproverPositionKey UNIQUEIDENTIFIER NULL,
    IsRequired      BIT DEFAULT 1
);
```

Khi tạo đơn hàng, hệ thống chạy `evaluateIsStandardDeal()` → tra đúng bộ bước duyệt trong `ApprovalMatrixRules` → sinh các bước duyệt (dùng chung 1 engine phê duyệt đa bước cho toàn hệ thống, không viết riêng cho từng module).

### 7.3. Chốt cứng hạn mức tại thời điểm duyệt

Ghi lại đúng số hạn mức còn lại **tại thời điểm duyệt** (`CreditCheckedAt`, `CreditAvailableAtCheck`) — có bằng chứng rõ ràng nếu sau này có tranh chấp về quyết định duyệt.

---

## 8. MODULE CÔNG NỢ ĐẠI LÝ + API TÍCH HỢP KẾ TOÁN

### 8.1. Công nợ là Sổ cái, không phải 1 trường số đơn giản

```sql
CREATE TABLE dbo.DealerLedger (
    LedgerId        BIGINT IDENTITY PRIMARY KEY,
    DealerId        INT NOT NULL,
    EntryType       NVARCHAR(20),    -- 'INVOICE' / 'PAYMENT' / 'CREDIT_NOTE'
    Amount          DECIMAL(18,2),
    RefType         NVARCHAR(30), RefId BIGINT,
    EntryDate       DATE,
    SyncedToAccountingAt DATETIME2 NULL,
    CreatedAt       DATETIME2 DEFAULT SYSUTCDATETIME()
);
-- Công nợ hiện tại = SUM(Amount) — tính động, không lưu cột "công nợ hiện tại" riêng dễ lệch dữ liệu
```

### 8.2. Kiến trúc API kế toán — độc lập nhà cung cấp (Adapter Pattern)

Quyết định thiết kế quan trọng (xem lý do đầy đủ ở Mục 15.2): thay vì viết cứng theo 1 phần mềm kế toán cụ thể, dùng **hàng đợi trung gian + adapter cắm được** — cho phép đổi/thêm phần mềm kế toán sau này mà không sửa lại toàn bộ luồng nghiệp vụ.

```sql
CREATE TABLE dbo.AccountingSyncQueue (
    QueueId         BIGINT IDENTITY PRIMARY KEY,
    EntryType       NVARCHAR(20),    -- INVOICE / PAYMENT_CONFIRM
    PayloadJson     NVARCHAR(MAX),   -- dữ liệu dạng chuẩn hoá (canonical), CHƯA map theo định dạng riêng của phần mềm kế toán
    Status          NVARCHAR(20) DEFAULT 'PENDING',  -- PENDING / SENT / FAILED
    RetryCount      INT DEFAULT 0,
    LastError       NVARCHAR(1000) NULL,
    CreatedAt       DATETIME2 DEFAULT SYSUTCDATETIME(),
    SentAt          DATETIME2 NULL
);
```

```javascript
// Interface chuẩn — mọi phần mềm kế toán cụ thể implement lại đúng 2 hàm này
class AccountingAdapter {
  async pushInvoice(canonicalInvoice) { throw new Error('Chưa cài đặt adapter cụ thể'); }
  async pushPaymentQuery(dealerCode) { throw new Error('Chưa cài đặt adapter cụ thể'); }
}

// Ví dụ 1: đã xác định dùng MISA (API thật) — cắm vào khi có thông tin chính thức
class MisaAdapter extends AccountingAdapter {
  async pushInvoice(inv) { /* gọi MISA AMIS OpenAPI thật */ }
}

// Ví dụ 2 (fallback AN TOÀN khi CHƯA xác định phần mềm kế toán): xuất Excel định kỳ để kế toán tự import tay
class ExcelExportAdapter extends AccountingAdapter {
  async pushInvoice(inv) { /* ghi vào file Excel chờ kế toán tải về, tránh chặn luồng bán hàng vì thiếu tích hợp thật */ }
}
```

Chiều ngược lại (kế toán xác nhận đã thu tiền → ghi vào `DealerLedger`):
```
POST /api/external/payment-confirmations
  Headers: X-API-Key: <khóa riêng cho phần mềm kế toán>
  Body: { dealerCode, amount, paymentDate, referenceNo }
```
Áp dụng đúng nguyên tắc bảo mật đã kiểm chứng: API Key riêng + IP allowlist, rate limit, ghi log mọi lượt gọi, **chỉ được thêm dòng mới** (không sửa/xóa `DealerLedger` — sổ cái append-only).

### 8.3. Cảnh báo tự động — nối vào Mục 7

```sql
SELECT SUM(Amount) AS CurrentDebt FROM dbo.DealerLedger WHERE DealerId = @DealerId;
-- currentDebt + đơn hàng mới > CreditLimit → tự động gắn cờ OVER_CREDIT
```

---

## 9. MODULE HỢP ĐỒNG & THANH TOÁN

Tái dùng thiết kế Hợp Đồng & Thanh Toán đã kiểm chứng, khác đối tượng hợp đồng:
- **Hợp đồng khung với Đại lý** — hiệu lực dài hạn, không theo từng đơn hàng.
- **Hợp đồng theo Dự án** — 1 hợp đồng/1 dự án, phụ lục thanh toán theo giai đoạn (tạm ứng/nghiệm thu/quyết toán).
- **Thanh toán**: tách bước "Duyệt chi" và "Xác nhận đã thu tiền" — hướng thu tiền từ đại lý/dự án liên kết trực tiếp `DealerLedger`.

---

## 10. MODULE ĐỘI NGŨ SALE / CRM

```sql
CREATE TABLE dbo.SalesInteractions (
    InteractionId   BIGINT IDENTITY PRIMARY KEY,
    SalesEmployeeId INT NOT NULL,
    CustomerType    NVARCHAR(20),
    DealerId        INT NULL, ProjectId INT NULL,
    InteractionType NVARCHAR(20),    -- CALL/MEETING/EMAIL/VISIT
    Summary         NVARCHAR(1000),
    NextActionDate  DATE NULL,
    CreatedAt       DATETIME2 DEFAULT SYSUTCDATETIME()
);
```
Đổi Sale phụ trách phải giữ lịch sử (giống mô hình gán vị trí đã thiết kế) — báo cáo doanh số tính đúng theo Sale phụ trách **tại đúng thời điểm phát sinh đơn hàng**, không tính nhầm cho người mới nhận bàn giao sau này.

---

## 11. MODULE BÁO CÁO TỔNG HỢP

### 11.1. Kiến trúc dạng "dài", linh hoạt thêm chỉ số không cần sửa schema

```sql
CREATE TABLE dbo.Fact_Sales (
    FactId INT IDENTITY PRIMARY KEY,
    ReportDate DATE, DealerId INT NULL, ProjectId INT NULL, ProductCategoryId INT, ChannelId INT, SalesEmployeeId INT,
    MeasureCode NVARCHAR(30),   -- REVENUE / COGS / GROSS_MARGIN / QTY / DISCOUNT_AMOUNT
    MeasureValue DECIMAL(18,2)
);
```

### 11.2. Báo cáo theo Form mẫu VÀ theo bộ lọc động

- **Theo form mẫu**: cấu hình sẵn cột + filter cho báo cáo dùng lặp lại — chọn mẫu, bấm chạy.
- **Theo bộ lọc động hoàn toàn**: chọn tùy ý Chiều (đại lý/sản phẩm/kênh/sale/khu vực) × Chỉ số × Khoảng thời gian.
- **Xuất Excel**: cả 2 chế độ, chống Formula Injection.

### 11.3. Danh sách báo cáo cụ thể

| Báo cáo | Chỉ số chính |
|---|---|
| Doanh thu đại lý theo tháng/quý/năm | Doanh thu, tăng trưởng % so kỳ trước/cùng kỳ |
| Chân dung khách hàng đại lý | Tần suất mua, giá trị đơn TB, cơ cấu sản phẩm, % hạn mức đã dùng |
| Chân dung & doanh thu khách hàng dự án | Tỷ lệ thắng thầu, giá trị TB/dự án, thời gian chốt deal |
| Công nợ & tuổi nợ | Theo đại lý, nhóm tuổi nợ (0-30/31-60/61-90/>90 ngày) |
| Tồn kho & vòng quay hàng | Tồn kho hiện tại, tốc độ bán, hàng chậm luân chuyển |
| Hiệu suất kênh bán | Doanh thu/tỷ trọng theo kênh |
| Hiệu suất Sale | Doanh số, số cơ hội đang xử lý, tỷ lệ chốt |

---

## 12. MODULE HỆ THỐNG

| Thành phần | Mô tả |
|---|---|
| Nhật ký hệ thống | Ghi mọi thao tác nhạy cảm tại server — đặc biệt đổi hạn mức đại lý, duyệt ngoại lệ, sửa bảng giá |
| Cấu hình phê duyệt | Ma trận Mục 7 + các luồng khác — dùng chung 1 engine |
| Biểu mẫu | Tùy biến trường nhập liệu không cần sửa code |
| Cấu hình giới hạn file & Email | Giới hạn dung lượng đính kèm, SMTP thông báo duyệt |
| Quản lý danh mục dùng chung | Khu vực, Hạng đại lý, Danh mục sản phẩm |

---

## 13. PHÂN QUYỀN TỔNG HỢP

```javascript
perms: {
  warehouseManage: false,
  dealerManage: false,
  dealerCreditOverride: false,   // tách riêng, cấp rất hạn chế
  projectManage: false,
  salesOrderCreate: true,
  salesApproveStandard: false,
  salesApproveException: false,
  accountingApiAccess: false,    // cấp cho hệ thống ngoài qua API Key riêng, không phải quyền người dùng
  reportViewFinance: false,      // tách khỏi báo cáo doanh số thường
}
```

---

## 14. LỘ TRÌNH TRIỂN KHAI

1. **Giai đoạn 1 — Nền tảng**: Danh mục (2) + Kho hàng (3) + Module Hệ thống cơ bản (12).
2. **Giai đoạn 2 — Khách hàng & Bán hàng**: Đại lý (4) + Dự án (5) + Bán hàng đa kênh (6).
3. **Giai đoạn 3 — Kiểm soát**: Ma trận phê duyệt (7) + Công nợ + API kế toán dạng adapter (8) — ưu tiên dùng `ExcelExportAdapter` trước để không chặn tiến độ, thay bằng adapter thật ngay khi xác nhận phần mềm kế toán.
4. **Giai đoạn 4**: Hợp đồng & Thanh toán (9) + CRM (10).
5. **Giai đoạn 5**: Báo cáo tổng hợp (11).

---

## 15. QUYẾT ĐỊNH THIẾT KẾ ĐÃ CHỐT (Phương án tối ưu — điều chỉnh được khi có số liệu thực tế)

### 15.1. Ngưỡng chuẩn/ngoại lệ & hạn mức tín dụng ban đầu

**Chiết khấu tự quyết tối đa theo hạng** (cấu hình được ở `DealerTiers.DefaultMaxDiscountPct`, số dưới là điểm khởi tạo hợp lý):

| Hạng | % tự quyết tối đa |
|---|---|
| Kim Cương | 10% |
| Vàng | 7% |
| Bạc | 4% |
| Đồng/Mới | 2% |

**Công thức hạn mức tín dụng khởi tạo cho đại lý mới:**
```
HạnMứcKhởiTạo = MIN(
    HạnMứcMặcĐịnhTheoHạng,
    3 × GiáTrịĐơnHàngCam kết ban đầu,
    NgưỡngAnToànTốiĐaChoĐạiLýMới   -- đề xuất 500.000.000đ, cấu hình được
)
```
Sau đúng **3 tháng giao dịch** (tính từ `Dealers.OnboardedAt`), hệ thống tự nhắc xét tăng hạn mức qua `DealerCreditReviews` nếu tỷ lệ thanh toán đúng hạn ≥ 95% — **không tự động tăng**, luôn cần phê duyệt qua ma trận Mục 7 (nhánh "Đổi hạng/hạn mức đại lý").

### 15.2. Phần mềm kế toán — chưa xác định, xử lý bằng kiến trúc Adapter

Vì chưa biết công ty dùng MISA/Fast/SAP hay phần mềm khác, quyết định tối ưu là **không chờ xác nhận mới bắt đầu code module Công nợ** — xây `AccountingSyncQueue` (Mục 8.2) làm lớp trung gian trước, dùng `ExcelExportAdapter` (xuất Excel cho kế toán tự nhập tay) làm phương án chạy được ngay. Khi xác nhận đúng phần mềm, chỉ cần viết thêm 1 class Adapter tương ứng (MISA AMIS OpenAPI, Fast Web Service, hoặc API tuỳ chỉnh), không phải sửa lại toàn bộ luồng nghiệp vụ Bán hàng/Công nợ đã chạy ổn định.

### 15.3. Serial Number — bật theo Danh mục sản phẩm, không bật toàn bộ

Đề xuất `DefaultSerialTracking = 1` cho các danh mục: **Server, Switch/Router, Thiết bị lưu trữ (Storage), Laptop/PC, Máy in** (có bảo hành nhà sản xuất tính theo serial, giá trị cao). Tắt (`= 0`) cho: cáp, phụ kiện, linh kiện tiêu hao — tránh phát sinh thao tác nhập serial không cần thiết cho hàng giá trị thấp, số lượng lớn. Từng SKU cá biệt vẫn override riêng qua `Products.HasSerialTracking` nếu cần khác Danh mục cha.

### 15.4. Thời gian giữ hàng (Reservation) tự hết hạn — theo từng kênh

Cấu hình mặc định ở `SalesChannels.DefaultReservationHours`:

| Kênh | Thời gian giữ hàng | Xử lý khi hết hạn |
|---|---|---|
| Website/Marketplace B2C | 0.5 giờ (30 phút, kiểu giỏ hàng) | Tự nhả hàng ngay, không cần duyệt |
| Cổng đại lý tự đặt (B2B) | 72 giờ làm việc | Cron quét mỗi giờ; cảnh báo email người duyệt trước 12h hết hạn; hết hạn → `Status='CANCELLED_EXPIRED'`, tự nhả `ReservedQty` |
| Sale trực tiếp tạo hộ | 72 giờ làm việc | Giống trên |

### 15.5. Khách B2C — mặc định thanh toán trước, không qua ma trận phê duyệt Mục 7

`SalesOrders.RequiresCreditCheck = 0` mặc định cho `OrderType='B2C'` — thanh toán trước/COD, không tạo dòng `DealerLedger`, không qua thẩm định tín dụng. Trường hợp hiếm gặp 1 khách lẻ lớn cần mua công nợ: xử lý bằng cách tạo hồ sơ khách đó **như 1 Đại lý** (dù bản chất là mua lẻ) để tái dùng nguyên cơ chế đã có, tránh phải mở thêm 1 nhánh logic riêng chỉ phục vụ số ít trường hợp ngoại lệ.

---

## 16. VIỆC CẦN LÀM TIẾP — KHÔNG CHẶN TIẾN ĐỘ, XÁC NHẬN SONG SONG KHI TRIỂN KHAI

Các con số ở Mục 15 (% chiết khấu, ngưỡng an toàn hạn mức, số giờ giữ hàng...) đều đã đưa vào dạng **cấu hình**, không hardcode — nghĩa là đội phát triển có thể bắt tay code ngay theo đúng khung này, và khi bạn có số liệu thực tế/chính sách chính thức của công ty (đặc biệt là phần mềm kế toán đang dùng), chỉ cần **đổi giá trị cấu hình hoặc thêm 1 Adapter**, không phải thiết kế lại.
