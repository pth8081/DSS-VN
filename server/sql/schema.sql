-- ============================================================================
-- NỀN TẢNG QUẢN TRỊ VẬN HÀNH — PHÂN PHỐI CNTT (Distribution Operations Platform)
-- Giai đoạn 1: Danh mục nền tảng + Kho hàng + Hệ thống cơ bản
--
-- Script idempotent: chạy lại nhiều lần không lỗi, không mất dữ liệu.
-- Mỗi bảng/proc bọc IF OBJECT_ID(...) IS NULL trước khi CREATE.
-- ============================================================================

IF DB_ID('DSS_VN') IS NULL
BEGIN
    CREATE DATABASE DSS_VN;
END
GO

USE DSS_VN;
GO

-- ============================================================================
-- MODULE 12: HỆ THỐNG CƠ BẢN — Vị trí, Nhân viên, Tài khoản, Nhật ký, Cấu hình
-- ============================================================================

IF OBJECT_ID('dbo.Positions') IS NULL
BEGIN
    CREATE TABLE dbo.Positions (
        PositionId      INT IDENTITY PRIMARY KEY,
        PositionCode    NVARCHAR(50) UNIQUE NOT NULL,
        PositionName    NVARCHAR(200) NOT NULL,
        Department      NVARCHAR(150) NULL,
        DisplayOrder    INT NOT NULL DEFAULT 0,
        IsActive        BIT NOT NULL DEFAULT 1
    );
END
GO

IF OBJECT_ID('dbo.Employees') IS NULL
BEGIN
    CREATE TABLE dbo.Employees (
        EmployeeId      INT IDENTITY PRIMARY KEY,
        EmployeeCode    NVARCHAR(50) UNIQUE NOT NULL,
        FullName        NVARCHAR(200) NOT NULL,
        Email           NVARCHAR(150) NULL,
        Phone           NVARCHAR(30) NULL,
        Department      NVARCHAR(150) NULL,
        PositionId      INT NULL REFERENCES dbo.Positions(PositionId),
        IsActive        BIT NOT NULL DEFAULT 1,
        CreatedAt       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

-- Lịch sử gán vị trí — seat-based: 1 nhân viên có thể đổi vị trí theo thời gian,
-- nghiệp vụ tra cứu "ai giữ vị trí X tại thời điểm Y" (VD báo cáo doanh số Sale
-- phụ trách đúng tại thời điểm phát sinh đơn hàng — xem Module 10) dựa vào bảng này.
IF OBJECT_ID('dbo.EmployeePositionHistory') IS NULL
BEGIN
    CREATE TABLE dbo.EmployeePositionHistory (
        HistoryId       INT IDENTITY PRIMARY KEY,
        EmployeeId      INT NOT NULL REFERENCES dbo.Employees(EmployeeId),
        PositionId      INT NOT NULL REFERENCES dbo.Positions(PositionId),
        StartDate       DATE NOT NULL,
        EndDate         DATE NULL,
        CreatedAt       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

IF OBJECT_ID('dbo.Users') IS NULL
BEGIN
    CREATE TABLE dbo.Users (
        UserId          INT IDENTITY PRIMARY KEY,
        Username        NVARCHAR(100) UNIQUE NOT NULL,
        PasswordHash    NVARCHAR(200) NOT NULL,
        EmployeeId      INT NULL REFERENCES dbo.Employees(EmployeeId),
        IsAdmin         BIT NOT NULL DEFAULT 0,
        PermsJson       NVARCHAR(MAX) NOT NULL DEFAULT '{}',
        IsActive        BIT NOT NULL DEFAULT 1,
        LastLoginAt     DATETIME2 NULL,
        CreatedAt       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

IF OBJECT_ID('dbo.SystemLog') IS NULL
BEGIN
    CREATE TABLE dbo.SystemLog (
        LogId           BIGINT IDENTITY PRIMARY KEY,
        UserId          INT NULL,
        Username        NVARCHAR(100) NULL,
        Action          NVARCHAR(100) NOT NULL,
        EntityType      NVARCHAR(60) NULL,
        EntityId        NVARCHAR(60) NULL,
        DetailJson      NVARCHAR(MAX) NULL,
        IPAddress       NVARCHAR(50) NULL,
        CreatedAt       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

IF OBJECT_ID('dbo.AppConfig') IS NULL
BEGIN
    CREATE TABLE dbo.AppConfig (
        ConfigKey       NVARCHAR(100) PRIMARY KEY,
        ConfigValue     NVARCHAR(MAX) NULL,
        UpdatedAt       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

-- Quản lý danh mục dùng chung (Module 12): Khu vực, Hạng đại lý
IF OBJECT_ID('dbo.Regions') IS NULL
BEGIN
    CREATE TABLE dbo.Regions (
        RegionId        INT IDENTITY PRIMARY KEY,
        RegionCode      NVARCHAR(30) UNIQUE NOT NULL,
        RegionName      NVARCHAR(150) NOT NULL,
        DisplayOrder    INT NOT NULL DEFAULT 0,
        IsActive        BIT NOT NULL DEFAULT 1
    );
END
GO

-- Hạng đại lý — chỉ định nghĩa cấu hình hạng ở Giai đoạn 1 (bảng Dealers thật
-- sự thuộc Module 4 / Giai đoạn 2); cần có sẵn vì PriceLists tham chiếu TierId.
IF OBJECT_ID('dbo.DealerTiers') IS NULL
BEGIN
    CREATE TABLE dbo.DealerTiers (
        TierId                  INT IDENTITY PRIMARY KEY,
        TierName                NVARCHAR(50) NOT NULL,   -- Kim Cương / Vàng / Bạc / Đồng
        DefaultCreditLimit      DECIMAL(18,2) NOT NULL DEFAULT 0,
        DefaultPaymentTermDays  INT NOT NULL DEFAULT 0,
        DefaultMaxDiscountPct   DECIMAL(5,2) NOT NULL DEFAULT 0,
        DisplayOrder            INT NOT NULL DEFAULT 0,
        IsActive                BIT NOT NULL DEFAULT 1
    );
END
GO

-- ============================================================================
-- MODULE 2: DANH MỤC NỀN TẢNG (Master Data)
-- ============================================================================

IF OBJECT_ID('dbo.ProductCategories') IS NULL
BEGIN
    CREATE TABLE dbo.ProductCategories (
        CategoryId              INT IDENTITY PRIMARY KEY,
        CategoryName            NVARCHAR(150) NOT NULL,
        DefaultSerialTracking   BIT NOT NULL DEFAULT 0,
        IsActive                BIT NOT NULL DEFAULT 1
    );
END
GO

IF OBJECT_ID('dbo.Products') IS NULL
BEGIN
    CREATE TABLE dbo.Products (
        ProductId           INT IDENTITY PRIMARY KEY,
        SKU                 NVARCHAR(50) UNIQUE NOT NULL,
        ProductName         NVARCHAR(300) NOT NULL,
        Brand               NVARCHAR(100) NULL,
        CategoryId          INT NULL REFERENCES dbo.ProductCategories(CategoryId),
        UnitOfMeasure       NVARCHAR(20) NOT NULL DEFAULT 'Cái',
        HasSerialTracking   BIT NULL,   -- NULL = kế thừa DefaultSerialTracking của Category
        CostingMethod       NVARCHAR(20) NOT NULL DEFAULT 'WEIGHTED_AVG',
        IsActive            BIT NOT NULL DEFAULT 1,
        CreatedAt           DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

IF OBJECT_ID('dbo.Warehouses') IS NULL
BEGIN
    CREATE TABLE dbo.Warehouses (
        WarehouseId     INT IDENTITY PRIMARY KEY,
        WarehouseCode   NVARCHAR(30) UNIQUE NOT NULL,
        WarehouseName   NVARCHAR(200) NOT NULL,
        Address         NVARCHAR(300) NULL,
        IsActive        BIT NOT NULL DEFAULT 1
    );
END
GO

IF OBJECT_ID('dbo.PriceLists') IS NULL
BEGIN
    CREATE TABLE dbo.PriceLists (
        PriceListId     INT IDENTITY PRIMARY KEY,
        PriceListName   NVARCHAR(200) NOT NULL,
        DealerTierId    INT NULL REFERENCES dbo.DealerTiers(TierId),
        EffectiveFrom   DATE NOT NULL,
        EffectiveTo     DATE NULL,
        Status          NVARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    );
END
GO

IF OBJECT_ID('dbo.PriceListItems') IS NULL
BEGIN
    CREATE TABLE dbo.PriceListItems (
        PriceListItemId INT IDENTITY PRIMARY KEY,
        PriceListId     INT NOT NULL REFERENCES dbo.PriceLists(PriceListId),
        ProductId       INT NOT NULL REFERENCES dbo.Products(ProductId),
        ListPrice       DECIMAL(18,2) NOT NULL DEFAULT 0,
        MaxDiscountPct  DECIMAL(5,2) NOT NULL DEFAULT 0,
        CONSTRAINT UQ_PriceListItems UNIQUE (PriceListId, ProductId)
    );
END
GO

-- ============================================================================
-- MODULE 3: KHO HÀNG
-- ============================================================================

IF OBJECT_ID('dbo.InventoryBalances') IS NULL
BEGIN
    CREATE TABLE dbo.InventoryBalances (
        ProductId       INT NOT NULL REFERENCES dbo.Products(ProductId),
        WarehouseId     INT NOT NULL REFERENCES dbo.Warehouses(WarehouseId),
        OnHandQty       DECIMAL(18,2) NOT NULL DEFAULT 0,
        ReservedQty     DECIMAL(18,2) NOT NULL DEFAULT 0,
        AvgCost         DECIMAL(18,4) NOT NULL DEFAULT 0,
        PRIMARY KEY (ProductId, WarehouseId)
    );
END
GO

IF OBJECT_ID('dbo.InventoryTransactions') IS NULL
BEGIN
    CREATE TABLE dbo.InventoryTransactions (
        TransId         BIGINT IDENTITY PRIMARY KEY,
        ProductId       INT NOT NULL,
        WarehouseId     INT NOT NULL,
        TransType       NVARCHAR(30) NOT NULL,   -- IMPORT_PO / EXPORT_SALE / TRANSFER_OUT / TRANSFER_IN / ADJUST / RETURN_IN / RETURN_OUT
        Quantity        DECIMAL(18,2) NOT NULL,
        UnitCost        DECIMAL(18,4) NULL,
        RefType         NVARCHAR(30) NULL,
        RefId           BIGINT NULL,
        SerialNumbers   NVARCHAR(MAX) NULL,
        Note            NVARCHAR(500) NULL,
        CreatedBy       NVARCHAR(100) NULL,
        CreatedAt       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

-- ----------------------------------------------------------------------------
-- Stored procedures kho hàng — mọi thao tác thay đổi tồn kho PHẢI đi qua đây,
-- không cho phép UPDATE trực tiếp InventoryBalances từ tầng ứng dụng
-- (Zero Trust + Chặn ở CSDL: dùng UPDLOCK/ROWLOCK tránh 2 giao dịch cùng vượt giới hạn).
-- ----------------------------------------------------------------------------

CREATE OR ALTER PROCEDURE dbo.EnsureInventoryBalanceRow
    @ProductId INT, @WarehouseId INT
AS
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dbo.InventoryBalances WHERE ProductId=@ProductId AND WarehouseId=@WarehouseId)
    BEGIN
        INSERT INTO dbo.InventoryBalances (ProductId, WarehouseId, OnHandQty, ReservedQty, AvgCost)
        VALUES (@ProductId, @WarehouseId, 0, 0, 0);
    END
END
GO

CREATE OR ALTER PROCEDURE dbo.ImportStock
    @ProductId INT, @WarehouseId INT, @Qty DECIMAL(18,2), @UnitCost DECIMAL(18,4),
    @RefType NVARCHAR(30) = NULL, @RefId BIGINT = NULL, @SerialNumbers NVARCHAR(MAX) = NULL,
    @Note NVARCHAR(500) = NULL, @CreatedBy NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @Qty <= 0 THROW 50010, N'Số lượng nhập kho phải lớn hơn 0', 1;

    BEGIN TRANSACTION;
    BEGIN TRY
        EXEC dbo.EnsureInventoryBalanceRow @ProductId, @WarehouseId;

        DECLARE @OldQty DECIMAL(18,2), @OldCost DECIMAL(18,4), @NewCost DECIMAL(18,4);
        SELECT @OldQty = OnHandQty, @OldCost = AvgCost FROM dbo.InventoryBalances WITH (UPDLOCK, ROWLOCK)
        WHERE ProductId=@ProductId AND WarehouseId=@WarehouseId;

        SET @NewCost = CASE WHEN (@OldQty + @Qty) = 0 THEN @OldCost
                             ELSE ((@OldQty * @OldCost) + (@Qty * @UnitCost)) / (@OldQty + @Qty) END;

        UPDATE dbo.InventoryBalances
        SET OnHandQty = OnHandQty + @Qty, AvgCost = @NewCost
        WHERE ProductId=@ProductId AND WarehouseId=@WarehouseId;

        INSERT INTO dbo.InventoryTransactions (ProductId, WarehouseId, TransType, Quantity, UnitCost, RefType, RefId, SerialNumbers, Note, CreatedBy)
        VALUES (@ProductId, @WarehouseId, 'IMPORT_PO', @Qty, @UnitCost, @RefType, @RefId, @SerialNumbers, @Note, @CreatedBy);

        COMMIT;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        THROW;
    END CATCH
END
GO

CREATE OR ALTER PROCEDURE dbo.AdjustStock
    @ProductId INT, @WarehouseId INT, @NewOnHandQty DECIMAL(18,2),
    @Note NVARCHAR(500) = NULL, @CreatedBy NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @NewOnHandQty < 0 THROW 50011, N'Tồn kho sau điều chỉnh không được âm', 1;

    BEGIN TRANSACTION;
    BEGIN TRY
        EXEC dbo.EnsureInventoryBalanceRow @ProductId, @WarehouseId;

        DECLARE @OldQty DECIMAL(18,2), @Reserved DECIMAL(18,2), @Diff DECIMAL(18,2);
        SELECT @OldQty = OnHandQty, @Reserved = ReservedQty FROM dbo.InventoryBalances WITH (UPDLOCK, ROWLOCK)
        WHERE ProductId=@ProductId AND WarehouseId=@WarehouseId;

        IF @NewOnHandQty < @Reserved
            THROW 50012, N'Tồn kho sau điều chỉnh nhỏ hơn số lượng đã giữ hàng', 1;

        SET @Diff = @NewOnHandQty - @OldQty;
        IF @Diff = 0 BEGIN COMMIT; RETURN; END

        UPDATE dbo.InventoryBalances SET OnHandQty = @NewOnHandQty
        WHERE ProductId=@ProductId AND WarehouseId=@WarehouseId;

        INSERT INTO dbo.InventoryTransactions (ProductId, WarehouseId, TransType, Quantity, Note, CreatedBy)
        VALUES (@ProductId, @WarehouseId, 'ADJUST', @Diff, @Note, @CreatedBy);

        COMMIT;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        THROW;
    END CATCH
END
GO

CREATE OR ALTER PROCEDURE dbo.TransferStock
    @ProductId INT, @FromWarehouseId INT, @ToWarehouseId INT, @Qty DECIMAL(18,2),
    @Note NVARCHAR(500) = NULL, @CreatedBy NVARCHAR(100) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @Qty <= 0 THROW 50013, N'Số lượng chuyển kho phải lớn hơn 0', 1;
    IF @FromWarehouseId = @ToWarehouseId THROW 50014, N'Kho nguồn và kho đích phải khác nhau', 1;

    BEGIN TRANSACTION;
    BEGIN TRY
        EXEC dbo.EnsureInventoryBalanceRow @ProductId, @FromWarehouseId;
        EXEC dbo.EnsureInventoryBalanceRow @ProductId, @ToWarehouseId;

        DECLARE @Available DECIMAL(18,2), @Cost DECIMAL(18,4);
        SELECT @Available = OnHandQty - ReservedQty, @Cost = AvgCost FROM dbo.InventoryBalances WITH (UPDLOCK, ROWLOCK)
        WHERE ProductId=@ProductId AND WarehouseId=@FromWarehouseId;

        IF @Available < @Qty THROW 50015, N'Không đủ tồn kho khả dụng tại kho nguồn để chuyển', 1;

        UPDATE dbo.InventoryBalances SET OnHandQty = OnHandQty - @Qty
        WHERE ProductId=@ProductId AND WarehouseId=@FromWarehouseId;

        DECLARE @ToOldQty DECIMAL(18,2), @ToOldCost DECIMAL(18,4);
        SELECT @ToOldQty = OnHandQty, @ToOldCost = AvgCost FROM dbo.InventoryBalances WITH (UPDLOCK, ROWLOCK)
        WHERE ProductId=@ProductId AND WarehouseId=@ToWarehouseId;

        UPDATE dbo.InventoryBalances
        SET OnHandQty = OnHandQty + @Qty,
            AvgCost = CASE WHEN (@ToOldQty + @Qty) = 0 THEN @ToOldCost
                           ELSE ((@ToOldQty * @ToOldCost) + (@Qty * @Cost)) / (@ToOldQty + @Qty) END
        WHERE ProductId=@ProductId AND WarehouseId=@ToWarehouseId;

        INSERT INTO dbo.InventoryTransactions (ProductId, WarehouseId, TransType, Quantity, UnitCost, Note, CreatedBy)
        VALUES (@ProductId, @FromWarehouseId, 'TRANSFER_OUT', @Qty, @Cost, @Note, @CreatedBy);
        INSERT INTO dbo.InventoryTransactions (ProductId, WarehouseId, TransType, Quantity, UnitCost, Note, CreatedBy)
        VALUES (@ProductId, @ToWarehouseId, 'TRANSFER_IN', @Qty, @Cost, @Note, @CreatedBy);

        COMMIT;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        THROW;
    END CATCH
END
GO

-- Giữ hàng cho đơn hàng (dùng ở Giai đoạn 2 khi có SalesOrders) — chuẩn bị sẵn hạ tầng.
CREATE OR ALTER PROCEDURE dbo.ReserveStock
    @ProductId INT, @WarehouseId INT, @Qty DECIMAL(18,2), @RefType NVARCHAR(30), @RefId BIGINT
AS
BEGIN
    SET NOCOUNT ON;
    IF @Qty <= 0 THROW 50020, N'Số lượng giữ hàng phải lớn hơn 0', 1;

    BEGIN TRANSACTION;
    BEGIN TRY
        EXEC dbo.EnsureInventoryBalanceRow @ProductId, @WarehouseId;

        DECLARE @Available DECIMAL(18,2);
        SELECT @Available = OnHandQty - ReservedQty FROM dbo.InventoryBalances WITH (UPDLOCK, ROWLOCK)
        WHERE ProductId=@ProductId AND WarehouseId=@WarehouseId;

        IF @Available < @Qty THROW 50001, N'Không đủ tồn kho khả dụng', 1;

        UPDATE dbo.InventoryBalances SET ReservedQty = ReservedQty + @Qty
        WHERE ProductId=@ProductId AND WarehouseId=@WarehouseId;

        INSERT INTO dbo.InventoryTransactions (ProductId, WarehouseId, TransType, Quantity, RefType, RefId, Note)
        VALUES (@ProductId, @WarehouseId, 'RESERVE', @Qty, @RefType, @RefId, N'Giữ hàng cho đơn/đề xuất');

        COMMIT;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        THROW;
    END CATCH
END
GO

-- Nhả giữ hàng (hủy đơn / hết hạn giữ hàng) — không đổi OnHandQty, chỉ giảm ReservedQty.
CREATE OR ALTER PROCEDURE dbo.ReleaseStock
    @ProductId INT, @WarehouseId INT, @Qty DECIMAL(18,2), @RefType NVARCHAR(30), @RefId BIGINT
AS
BEGIN
    SET NOCOUNT ON;
    IF @Qty <= 0 THROW 50021, N'Số lượng nhả giữ hàng phải lớn hơn 0', 1;

    BEGIN TRANSACTION;
    BEGIN TRY
        DECLARE @Reserved DECIMAL(18,2);
        SELECT @Reserved = ReservedQty FROM dbo.InventoryBalances WITH (UPDLOCK, ROWLOCK)
        WHERE ProductId=@ProductId AND WarehouseId=@WarehouseId;

        IF @Reserved IS NULL OR @Reserved < @Qty
            THROW 50022, N'Số lượng nhả giữ hàng vượt quá số lượng đang giữ', 1;

        UPDATE dbo.InventoryBalances SET ReservedQty = ReservedQty - @Qty
        WHERE ProductId=@ProductId AND WarehouseId=@WarehouseId;

        INSERT INTO dbo.InventoryTransactions (ProductId, WarehouseId, TransType, Quantity, RefType, RefId, Note)
        VALUES (@ProductId, @WarehouseId, 'RELEASE', @Qty, @RefType, @RefId, N'Nhả giữ hàng');

        COMMIT;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        THROW;
    END CATCH
END
GO

-- ============================================================================
-- MODULE 4: QUẢN LÝ ĐẠI LÝ (Dealer Management) — Giai đoạn 2
-- ============================================================================

IF OBJECT_ID('dbo.Dealers') IS NULL
BEGIN
    CREATE TABLE dbo.Dealers (
        DealerId                INT IDENTITY PRIMARY KEY,
        DealerCode               NVARCHAR(30) UNIQUE NOT NULL,
        DealerName               NVARCHAR(300) NOT NULL,
        TaxCode                  NVARCHAR(20) NULL UNIQUE,
        TierId                   INT NULL REFERENCES dbo.DealerTiers(TierId),
        CreditLimitOverride      DECIMAL(18,2) NULL,
        PaymentTermDaysOverride  INT NULL,
        RegionId                 INT NULL REFERENCES dbo.Regions(RegionId),
        AssignedSalesId          INT NULL REFERENCES dbo.Employees(EmployeeId),
        OnboardedAt              DATE NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
        Status                   NVARCHAR(20) NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE / SUSPENDED / BLACKLIST
        CreatedAt                DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

-- Lịch sử xét duyệt hạn mức — phục vụ quy trình tăng hạn mức định kỳ (Mục 15.1
-- tài liệu thiết kế). Đổi TierId/CreditLimitOverride nên đi kèm 1 dòng ở đây
-- làm bằng chứng quyết định — ma trận phê duyệt thật cho việc đổi hạn mức sẽ
-- nối vào Module 7 (Giai đoạn 3), hiện tại (Giai đoạn 2) chỉ ghi nhận quyết
-- định, chưa có luồng duyệt nhiều cấp.
IF OBJECT_ID('dbo.DealerCreditReviews') IS NULL
BEGIN
    CREATE TABLE dbo.DealerCreditReviews (
        ReviewId            INT IDENTITY PRIMARY KEY,
        DealerId             INT NOT NULL REFERENCES dbo.Dealers(DealerId),
        ReviewDate           DATE NOT NULL DEFAULT CAST(SYSUTCDATETIME() AS DATE),
        OldLimit             DECIMAL(18,2) NOT NULL,
        ProposedLimit        DECIMAL(18,2) NOT NULL,
        OnTimePaymentRatio   DECIMAL(5,2) NULL,
        Decision             NVARCHAR(20) NOT NULL DEFAULT 'DEFERRED',   -- APPROVED / REJECTED / DEFERRED
        ApprovedBy           NVARCHAR(100) NULL,
        CreatedAt            DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

-- ============================================================================
-- MODULE 5: QUẢN LÝ KHÁCH HÀNG DỰ ÁN (Project Customer Management) — Giai đoạn 2
-- ============================================================================

IF OBJECT_ID('dbo.Projects') IS NULL
BEGIN
    CREATE TABLE dbo.Projects (
        ProjectId          INT IDENTITY PRIMARY KEY,
        ProjectName         NVARCHAR(300) NOT NULL,
        EndCustomerName      NVARCHAR(300) NULL,
        EstimatedValue       DECIMAL(18,2) NULL,
        Stage                NVARCHAR(30) NOT NULL DEFAULT 'LEAD',   -- LEAD/QUALIFIED/QUOTED/NEGOTIATION/WON/LOST/IMPLEMENTING/CLOSED
        ExpectedCloseDate    DATE NULL,
        CompetitorNotes      NVARCHAR(1000) NULL,
        AssignedSalesId      INT NULL REFERENCES dbo.Employees(EmployeeId),
        LostReason           NVARCHAR(300) NULL,
        CreatedAt            DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

IF OBJECT_ID('dbo.ProjectQuotes') IS NULL
BEGIN
    CREATE TABLE dbo.ProjectQuotes (
        QuoteId       INT IDENTITY PRIMARY KEY,
        ProjectId      INT NOT NULL REFERENCES dbo.Projects(ProjectId),
        QuoteVersion   INT NOT NULL,
        TotalAmount    DECIMAL(18,2) NOT NULL DEFAULT 0,
        Status         NVARCHAR(20) NOT NULL DEFAULT 'DRAFT',
        CreatedAt      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_ProjectQuotes UNIQUE (ProjectId, QuoteVersion)
    );
END
GO

-- ============================================================================
-- MODULE 6: BÁN HÀNG ĐA KÊNH (Omnichannel Sales) — Giai đoạn 2
--
-- Phạm vi Giai đoạn 2: tạo đơn (NHÁP) → gửi duyệt (giữ hàng thật qua
-- ReserveStock, tính tổng tiền) → hủy (thủ công hoặc tự động hết hạn giữ
-- hàng). Bước PENDING_APPROVAL → APPROVED → FULFILLED (xuất kho thật + phát
-- sinh công nợ) thuộc Module 7+8, triển khai ở Giai đoạn 3 — cột IsStandardDeal/
-- CreditCheckedAt/CreditAvailableAtCheck đã có sẵn trong bảng nhưng CHƯA được
-- điền ở Giai đoạn 2 (giá trị NULL).
-- ============================================================================

IF OBJECT_ID('dbo.SalesChannels') IS NULL
BEGIN
    CREATE TABLE dbo.SalesChannels (
        ChannelId                INT IDENTITY PRIMARY KEY,
        ChannelName               NVARCHAR(100) NOT NULL,
        ChannelType                NVARCHAR(20) NOT NULL,   -- DIRECT_SALES / ECOMMERCE / MARKETPLACE / DEALER_PORTAL
        DefaultReservationHours    DECIMAL(6,2) NOT NULL DEFAULT 72,
        IsActive                   BIT NOT NULL DEFAULT 1
    );
END
GO

IF OBJECT_ID('dbo.SalesOrders') IS NULL
BEGIN
    CREATE TABLE dbo.SalesOrders (
        OrderId                   BIGINT IDENTITY PRIMARY KEY,
        OrderCode                  NVARCHAR(30) UNIQUE NOT NULL,
        OrderType                  NVARCHAR(10) NOT NULL,   -- B2B / B2C
        ChannelId                  INT NULL REFERENCES dbo.SalesChannels(ChannelId),
        CustomerType                NVARCHAR(20) NOT NULL,   -- DEALER / PROJECT / RETAIL
        DealerId                   INT NULL REFERENCES dbo.Dealers(DealerId),
        ProjectId                  INT NULL REFERENCES dbo.Projects(ProjectId),
        CustomerName                NVARCHAR(200) NULL,      -- dùng cho CustomerType='RETAIL' (không có hồ sơ Dealer/Project)
        CustomerPhone               NVARCHAR(30) NULL,
        CustomerAddress             NVARCHAR(300) NULL,
        WarehouseId                 INT NOT NULL REFERENCES dbo.Warehouses(WarehouseId),
        Status                      NVARCHAR(20) NOT NULL DEFAULT 'DRAFT',
        -- DRAFT/PENDING_APPROVAL/APPROVED/FULFILLED/CANCELLED/CANCELLED_EXPIRED
        TotalAmount                 DECIMAL(18,2) NOT NULL DEFAULT 0,
        PaymentTermDays             INT NOT NULL DEFAULT 0,
        RequiresCreditCheck         BIT NOT NULL DEFAULT 1,   -- 0 cho Retail trả trước (Mục 15.5)
        IsStandardDeal               BIT NULL,                -- điền ở Giai đoạn 3 (Module 7)
        ReservationExpiresAt         DATETIME2 NULL,
        CreditCheckedAt              DATETIME2 NULL,          -- điền ở Giai đoạn 3 (Module 7)
        CreditAvailableAtCheck       DECIMAL(18,2) NULL,       -- điền ở Giai đoạn 3 (Module 7)
        CreatedBy                    NVARCHAR(100) NULL,
        CreatedAt                    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

IF OBJECT_ID('dbo.SalesOrderItems') IS NULL
BEGIN
    CREATE TABLE dbo.SalesOrderItems (
        OrderItemId    BIGINT IDENTITY PRIMARY KEY,
        OrderId         BIGINT NOT NULL REFERENCES dbo.SalesOrders(OrderId),
        ProductId       INT NOT NULL REFERENCES dbo.Products(ProductId),
        Quantity        DECIMAL(18,2) NOT NULL,
        UnitPrice       DECIMAL(18,2) NOT NULL,
        DiscountPct     DECIMAL(5,2) NOT NULL DEFAULT 0,
        LineTotal       AS (CAST(Quantity * UnitPrice * (1 - DiscountPct / 100.0) AS DECIMAL(18,2))) PERSISTED
    );
END
GO

-- Gửi duyệt đơn hàng: giữ hàng thật cho TỪNG dòng sản phẩm (qua ReserveStock —
-- dùng lại đúng 1 cơ chế giữ hàng cho mọi kênh, nguyên tắc Omnichannel bắt
-- buộc ở Module 6), tính lại tổng tiền, đặt hạn giữ hàng theo kênh.
CREATE OR ALTER PROCEDURE dbo.SubmitSalesOrder
    @OrderId BIGINT, @ReservationHours DECIMAL(6,2)
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @Status NVARCHAR(20), @WarehouseId INT;
    SELECT @Status = Status, @WarehouseId = WarehouseId FROM dbo.SalesOrders WHERE OrderId = @OrderId;
    IF @Status IS NULL THROW 50030, N'Không tìm thấy đơn hàng', 1;
    IF @Status <> 'DRAFT' THROW 50031, N'Chỉ có thể gửi duyệt đơn hàng đang ở trạng thái NHÁP', 1;
    IF NOT EXISTS (SELECT 1 FROM dbo.SalesOrderItems WHERE OrderId = @OrderId)
        THROW 50032, N'Đơn hàng chưa có sản phẩm nào', 1;

    BEGIN TRANSACTION;
    BEGIN TRY
        DECLARE @ProductId INT, @Qty DECIMAL(18,2);
        DECLARE item_cursor CURSOR LOCAL FAST_FORWARD FOR
            SELECT ProductId, Quantity FROM dbo.SalesOrderItems WHERE OrderId = @OrderId;
        OPEN item_cursor;
        FETCH NEXT FROM item_cursor INTO @ProductId, @Qty;
        WHILE @@FETCH_STATUS = 0
        BEGIN
            EXEC dbo.ReserveStock @ProductId=@ProductId, @WarehouseId=@WarehouseId, @Qty=@Qty,
                 @RefType='SalesOrder', @RefId=@OrderId;
            FETCH NEXT FROM item_cursor INTO @ProductId, @Qty;
        END
        CLOSE item_cursor; DEALLOCATE item_cursor;

        DECLARE @Total DECIMAL(18,2);
        SELECT @Total = SUM(LineTotal) FROM dbo.SalesOrderItems WHERE OrderId = @OrderId;

        UPDATE dbo.SalesOrders
        SET Status = 'PENDING_APPROVAL', TotalAmount = @Total,
            ReservationExpiresAt = DATEADD(MINUTE, CAST(@ReservationHours * 60 AS INT), SYSUTCDATETIME())
        WHERE OrderId = @OrderId;

        COMMIT;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        THROW;
    END CATCH
END
GO

-- Hủy đơn (thủ công @Expired=0, hoặc tự động do hết hạn giữ hàng @Expired=1
-- — xem server/jobs/expireReservations.js) — nhả lại đúng số lượng đã giữ.
CREATE OR ALTER PROCEDURE dbo.CancelSalesOrder
    @OrderId BIGINT, @Expired BIT = 0
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @Status NVARCHAR(20), @WarehouseId INT;
    SELECT @Status = Status, @WarehouseId = WarehouseId FROM dbo.SalesOrders WHERE OrderId = @OrderId;
    IF @Status IS NULL THROW 50033, N'Không tìm thấy đơn hàng', 1;
    IF @Status NOT IN ('DRAFT','PENDING_APPROVAL','APPROVED')
        THROW 50034, N'Đơn hàng ở trạng thái này không thể hủy', 1;

    BEGIN TRANSACTION;
    BEGIN TRY
        IF @Status IN ('PENDING_APPROVAL','APPROVED')
        BEGIN
            DECLARE @ProductId INT, @Qty DECIMAL(18,2);
            DECLARE item_cursor CURSOR LOCAL FAST_FORWARD FOR
                SELECT ProductId, Quantity FROM dbo.SalesOrderItems WHERE OrderId = @OrderId;
            OPEN item_cursor;
            FETCH NEXT FROM item_cursor INTO @ProductId, @Qty;
            WHILE @@FETCH_STATUS = 0
            BEGIN
                EXEC dbo.ReleaseStock @ProductId=@ProductId, @WarehouseId=@WarehouseId, @Qty=@Qty,
                     @RefType='SalesOrder', @RefId=@OrderId;
                FETCH NEXT FROM item_cursor INTO @ProductId, @Qty;
            END
            CLOSE item_cursor; DEALLOCATE item_cursor;
        END

        UPDATE dbo.SalesOrders
        SET Status = CASE WHEN @Expired = 1 THEN 'CANCELLED_EXPIRED' ELSE 'CANCELLED' END
        WHERE OrderId = @OrderId;

        COMMIT;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK;
        THROW;
    END CATCH
END
GO

-- ============================================================================
-- SEED DỮ LIỆU MẶC ĐỊNH (chỉ chạy nếu bảng rỗng — an toàn khi chạy lại script)
-- ============================================================================

IF NOT EXISTS (SELECT 1 FROM dbo.Positions)
BEGIN
    INSERT INTO dbo.Positions (PositionCode, PositionName, Department, DisplayOrder) VALUES
    (N'ADMIN', N'Quản trị hệ thống', N'IT', 0),
    (N'WAREHOUSE_STAFF', N'Nhân viên kho', N'Kho vận', 1),
    (N'WAREHOUSE_MANAGER', N'Trưởng kho', N'Kho vận', 2),
    (N'SALES_STAFF', N'Nhân viên kinh doanh', N'Kinh doanh', 3),
    (N'SALES_MANAGER', N'Trưởng phòng kinh doanh', N'Kinh doanh', 4);
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.Employees)
BEGIN
    INSERT INTO dbo.Employees (EmployeeCode, FullName, Department, PositionId, IsActive)
    SELECT N'NV000', N'Quản trị viên', N'IT', PositionId, 1 FROM dbo.Positions WHERE PositionCode = N'ADMIN';
END
GO

-- Tài khoản mặc định admin/123456 — ĐỔI MẬT KHẨU NGAY SAU KHI TRIỂN KHAI THẬT.
-- Hash bcrypt (10 rounds) của chuỗi "123456".
IF NOT EXISTS (SELECT 1 FROM dbo.Users)
BEGIN
    INSERT INTO dbo.Users (Username, PasswordHash, EmployeeId, IsAdmin, PermsJson, IsActive)
    SELECT N'admin', '$2a$10$VmhRxJmEJhokPWk1LqHp1utbq/vFxf6FgdWDlRLPwFoNSO8Ckv3sW',
           (SELECT TOP 1 EmployeeId FROM dbo.Employees WHERE EmployeeCode = N'NV000'), 1, N'{}', 1;
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.Warehouses)
BEGIN
    INSERT INTO dbo.Warehouses (WarehouseCode, WarehouseName, Address) VALUES
    (N'KHO-CHINH', N'Kho chính', NULL);
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.DealerTiers)
BEGIN
    INSERT INTO dbo.DealerTiers (TierName, DefaultCreditLimit, DefaultPaymentTermDays, DefaultMaxDiscountPct, DisplayOrder) VALUES
    (N'Kim Cương', 0, 30, 10, 0),
    (N'Vàng', 0, 30, 7, 1),
    (N'Bạc', 0, 15, 4, 2),
    (N'Đồng/Mới', 0, 0, 2, 3);
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.ProductCategories)
BEGIN
    INSERT INTO dbo.ProductCategories (CategoryName, DefaultSerialTracking) VALUES
    (N'Server', 1),
    (N'Switch/Router', 1),
    (N'Thiết bị lưu trữ (Storage)', 1),
    (N'Laptop/PC', 1),
    (N'Máy in', 1),
    (N'Cáp & Phụ kiện', 0),
    (N'Linh kiện tiêu hao', 0);
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.AppConfig)
BEGIN
    INSERT INTO dbo.AppConfig (ConfigKey, ConfigValue) VALUES
    (N'UPLOAD_MAX_MB', N'20'),
    (N'NEW_DEALER_SAFE_LIMIT', N'500000000');
END
GO

-- Thời gian giữ hàng mặc định theo kênh (Mục 15.4 tài liệu thiết kế).
IF NOT EXISTS (SELECT 1 FROM dbo.SalesChannels)
BEGIN
    INSERT INTO dbo.SalesChannels (ChannelName, ChannelType, DefaultReservationHours) VALUES
    (N'Website / Marketplace B2C', 'ECOMMERCE', 0.5),
    (N'Cổng đại lý tự đặt (B2B)', 'DEALER_PORTAL', 72),
    (N'Sale trực tiếp tạo hộ', 'DIRECT_SALES', 72);
END
GO
