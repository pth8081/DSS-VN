const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const PERIOD_EXPR = {
  month: `CONVERT(varchar(7), ReportDate, 126)`,
  quarter: `CONVERT(varchar(4), YEAR(ReportDate)) + '-Q' + CONVERT(varchar(1), DATEPART(QUARTER, ReportDate))`,
  year: `CONVERT(varchar(4), YEAR(ReportDate))`,
};

// --- 1. Doanh thu đại lý theo tháng/quý/năm + tăng trưởng % so kỳ trước ---
router.get('/dealer-revenue', requirePerm('reportView'), async (req, res) => {
  const period = PERIOD_EXPR[req.query.period] ? req.query.period : 'month';
  const pool = await getPool();
  const result = await pool.request().query(`
    WITH grouped AS (
      SELECT DealerId, ${PERIOD_EXPR[period]} AS PeriodKey, SUM(MeasureValue) AS Revenue
      FROM dbo.Fact_Sales WHERE MeasureCode = 'REVENUE' AND DealerId IS NOT NULL
      GROUP BY DealerId, ${PERIOD_EXPR[period]}
    )
    SELECT g.DealerId, d.DealerCode, d.DealerName, g.PeriodKey, g.Revenue,
           LAG(g.Revenue) OVER (PARTITION BY g.DealerId ORDER BY g.PeriodKey) AS PrevRevenue
    FROM grouped g JOIN dbo.Dealers d ON d.DealerId = g.DealerId
    ORDER BY d.DealerName, g.PeriodKey`);

  const rows = result.recordset.map((r) => ({
    ...r,
    GrowthPct: r.PrevRevenue ? Number((((r.Revenue - r.PrevRevenue) / r.PrevRevenue) * 100).toFixed(2)) : null,
  }));
  res.json(rows);
});

// --- 2. Chân dung khách hàng đại lý ---
router.get('/dealer-profile/:dealerId', requirePerm('reportView'), async (req, res) => {
  const pool = await getPool();
  const dealerId = req.params.dealerId;

  const orders = await pool.request().input('id', sql.Int, dealerId).query(`
    SELECT COUNT(*) AS OrderCount, ISNULL(AVG(TotalAmount), 0) AS AvgOrderValue
    FROM dbo.SalesOrders WHERE DealerId = @id AND Status = 'FULFILLED'`);

  const productMix = await pool.request().input('id', sql.Int, dealerId).query(`
    SELECT c.CategoryName, SUM(f.MeasureValue) AS Revenue
    FROM dbo.Fact_Sales f LEFT JOIN dbo.ProductCategories c ON c.CategoryId = f.ProductCategoryId
    WHERE f.DealerId = @id AND f.MeasureCode = 'REVENUE'
    GROUP BY c.CategoryName ORDER BY Revenue DESC`);

  const credit = await pool.request().input('id', sql.Int, dealerId).query(`
    SELECT COALESCE(d.CreditLimitOverride, t.DefaultCreditLimit, 0) AS EffectiveCreditLimit,
           ISNULL(ledger.CurrentDebt, 0) AS CurrentDebt
    FROM dbo.Dealers d LEFT JOIN dbo.DealerTiers t ON t.TierId = d.TierId
    OUTER APPLY (SELECT SUM(Amount) AS CurrentDebt FROM dbo.DealerLedger WHERE DealerId = d.DealerId) ledger
    WHERE d.DealerId = @id`);

  const c = credit.recordset[0] || { EffectiveCreditLimit: 0, CurrentDebt: 0 };
  const creditUsedPct = c.EffectiveCreditLimit > 0 ? Number(((c.CurrentDebt / c.EffectiveCreditLimit) * 100).toFixed(2)) : null;

  res.json({
    orderCount: orders.recordset[0].OrderCount,
    avgOrderValue: orders.recordset[0].AvgOrderValue,
    productMix: productMix.recordset,
    effectiveCreditLimit: c.EffectiveCreditLimit,
    currentDebt: c.CurrentDebt,
    creditUsedPct,
  });
});

// --- 3. Chân dung & doanh thu khách hàng dự án ---
router.get('/project-profile', requirePerm('reportView'), async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT
      COUNT(*) AS TotalClosed,
      SUM(CASE WHEN Stage = 'WON' THEN 1 ELSE 0 END) AS WonCount,
      SUM(CASE WHEN Stage = 'LOST' THEN 1 ELSE 0 END) AS LostCount,
      AVG(CASE WHEN Stage = 'WON' THEN EstimatedValue END) AS AvgWonValue,
      AVG(CASE WHEN Stage = 'WON' THEN DATEDIFF(DAY, CreatedAt, ExpectedCloseDate) END) AS AvgDaysToClose
    FROM dbo.Projects WHERE Stage IN ('WON', 'LOST')`);

  const row = result.recordset[0];
  const winRate = row.TotalClosed > 0 ? Number(((row.WonCount / row.TotalClosed) * 100).toFixed(2)) : null;
  res.json({ ...row, WinRatePct: winRate });
});

// --- 4. Công nợ & tuổi nợ (FIFO: thanh toán khớp vào hoá đơn cũ nhất trước) ---
router.get('/debt-aging', requirePerm('reportViewFinance'), async (req, res) => {
  const pool = await getPool();
  const dealers = await pool.request().query('SELECT DealerId, DealerCode, DealerName FROM dbo.Dealers');
  const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '>90': 0 };
  const rows = [];

  for (const dealer of dealers.recordset) {
    const ledger = await pool.request().input('id', sql.Int, dealer.DealerId).query(`
      SELECT EntryType, Amount, EntryDate FROM dbo.DealerLedger WHERE DealerId = @id ORDER BY EntryDate, LedgerId`);

    const invoices = ledger.recordset.filter((e) => e.EntryType === 'INVOICE').map((e) => ({ ...e, Remaining: Number(e.Amount) }));
    let paymentPool = ledger.recordset.filter((e) => e.EntryType !== 'INVOICE').reduce((sum, e) => sum + Math.abs(Number(e.Amount)), 0);
    for (const inv of invoices) {
      const applied = Math.min(paymentPool, inv.Remaining);
      inv.Remaining -= applied;
      paymentPool -= applied;
    }

    const dealerBuckets = { '0-30': 0, '31-60': 0, '61-90': 0, '>90': 0 };
    const today = new Date();
    for (const inv of invoices) {
      if (inv.Remaining <= 0) continue;
      const ageDays = Math.floor((today - new Date(inv.EntryDate)) / (1000 * 60 * 60 * 24));
      const key = ageDays <= 30 ? '0-30' : ageDays <= 60 ? '31-60' : ageDays <= 90 ? '61-90' : '>90';
      dealerBuckets[key] += inv.Remaining;
      buckets[key] += inv.Remaining;
    }

    const totalOutstanding = Object.values(dealerBuckets).reduce((a, b) => a + b, 0);
    if (totalOutstanding > 0) rows.push({ ...dealer, ...dealerBuckets, TotalOutstanding: totalOutstanding });
  }

  res.json({ totals: buckets, dealers: rows });
});

// --- 5. Tồn kho & vòng quay hàng ---
// Tốc độ bán lấy từ InventoryTransactions (TransType='EXPORT_SALE') — có đúng
// ProductId theo từng SKU; KHÔNG dùng Fact_Sales cho báo cáo này vì Fact_Sales
// (Mục 11.1) chỉ có ProductCategoryId (gộp theo nhóm sản phẩm), không đủ chi
// tiết để tính vòng quay đúng từng SKU.
router.get('/inventory-turnover', requirePerm('reportView'), async (req, res) => {
  const days = Number(req.query.days) || 30;
  const pool = await getPool();
  const result = await pool.request().input('days', sql.Int, days).query(`
    SELECT b.ProductId, p.SKU, p.ProductName, b.WarehouseId, w.WarehouseName,
           b.OnHandQty, b.ReservedQty, (b.OnHandQty - b.ReservedQty) AS AvailableQty,
           ISNULL(sold.QtySold, 0) AS QtySoldRecent,
           CASE WHEN b.OnHandQty > 0 THEN ROUND(ISNULL(sold.QtySold, 0) / b.OnHandQty, 2) ELSE NULL END AS TurnoverRatio
    FROM dbo.InventoryBalances b
    JOIN dbo.Products p ON p.ProductId = b.ProductId
    JOIN dbo.Warehouses w ON w.WarehouseId = b.WarehouseId
    OUTER APPLY (
      SELECT SUM(Quantity) AS QtySold FROM dbo.InventoryTransactions
      WHERE TransType = 'EXPORT_SALE' AND ProductId = b.ProductId AND WarehouseId = b.WarehouseId
        AND CreatedAt >= DATEADD(DAY, -@days, SYSUTCDATETIME())
    ) sold
    ORDER BY TurnoverRatio ASC`);
  res.json(result.recordset);
});

// --- 6. Hiệu suất kênh bán ---
router.get('/channel-performance', requirePerm('reportView'), async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT c.ChannelId, c.ChannelName, ISNULL(SUM(f.MeasureValue), 0) AS Revenue
    FROM dbo.SalesChannels c
    LEFT JOIN dbo.Fact_Sales f ON f.ChannelId = c.ChannelId AND f.MeasureCode = 'REVENUE'
    GROUP BY c.ChannelId, c.ChannelName ORDER BY Revenue DESC`);
  const total = result.recordset.reduce((sum, r) => sum + Number(r.Revenue), 0);
  res.json(result.recordset.map((r) => ({ ...r, SharePct: total > 0 ? Number(((r.Revenue / total) * 100).toFixed(2)) : 0 })));
});

// --- 7. Hiệu suất Sale ---
router.get('/sales-performance', requirePerm('reportView'), async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT e.EmployeeId, e.FullName,
           ISNULL(rev.Revenue, 0) AS Revenue,
           ISNULL(pipeline.OpenCount, 0) AS OpenOpportunities,
           ISNULL(closed.WonCount, 0) AS WonCount, ISNULL(closed.LostCount, 0) AS LostCount
    FROM dbo.Employees e
    OUTER APPLY (SELECT SUM(MeasureValue) AS Revenue FROM dbo.Fact_Sales WHERE MeasureCode='REVENUE' AND SalesEmployeeId = e.EmployeeId) rev
    OUTER APPLY (SELECT COUNT(*) AS OpenCount FROM dbo.Projects WHERE AssignedSalesId = e.EmployeeId AND Stage NOT IN ('WON','LOST','CLOSED')) pipeline
    OUTER APPLY (
      SELECT SUM(CASE WHEN Stage='WON' THEN 1 ELSE 0 END) AS WonCount, SUM(CASE WHEN Stage='LOST' THEN 1 ELSE 0 END) AS LostCount
      FROM dbo.Projects WHERE AssignedSalesId = e.EmployeeId AND Stage IN ('WON','LOST')
    ) closed
    WHERE ISNULL(rev.Revenue,0) > 0 OR ISNULL(pipeline.OpenCount,0) > 0 OR ISNULL(closed.WonCount,0) > 0 OR ISNULL(closed.LostCount,0) > 0
    ORDER BY Revenue DESC`);

  res.json(result.recordset.map((r) => ({
    ...r,
    WinRatePct: (r.WonCount + r.LostCount) > 0 ? Number(((r.WonCount / (r.WonCount + r.LostCount)) * 100).toFixed(2)) : null,
  })));
});

// --- Bộ lọc động: chọn tuỳ ý Chiều x Chỉ số x Khoảng thời gian (Mục 11.2) ---
const DIMENSIONS = {
  dealer: { select: 'f.DealerId AS DimId, d.DealerName AS DimLabel', join: 'LEFT JOIN dbo.Dealers d ON d.DealerId = f.DealerId', group: 'f.DealerId, d.DealerName' },
  product: { select: 'f.ProductCategoryId AS DimId, c.CategoryName AS DimLabel', join: 'LEFT JOIN dbo.ProductCategories c ON c.CategoryId = f.ProductCategoryId', group: 'f.ProductCategoryId, c.CategoryName' },
  channel: { select: 'f.ChannelId AS DimId, ch.ChannelName AS DimLabel', join: 'LEFT JOIN dbo.SalesChannels ch ON ch.ChannelId = f.ChannelId', group: 'f.ChannelId, ch.ChannelName' },
  sale: { select: 'f.SalesEmployeeId AS DimId, e.FullName AS DimLabel', join: 'LEFT JOIN dbo.Employees e ON e.EmployeeId = f.SalesEmployeeId', group: 'f.SalesEmployeeId, e.FullName' },
};
const MEASURES = ['REVENUE', 'COGS', 'GROSS_MARGIN', 'QTY', 'DISCOUNT_AMOUNT'];

router.get('/dynamic', requirePerm('reportView'), async (req, res) => {
  const dimension = DIMENSIONS[req.query.dimension] ? req.query.dimension : 'dealer';
  const measure = MEASURES.includes(req.query.measure) ? req.query.measure : 'REVENUE';
  const { from, to } = req.query;
  const dim = DIMENSIONS[dimension];

  const pool = await getPool();
  const request = pool.request().input('measure', sql.NVarChar, measure);
  const conditions = ['f.MeasureCode = @measure'];
  if (from) { request.input('from', sql.Date, from); conditions.push('f.ReportDate >= @from'); }
  if (to) { request.input('to', sql.Date, to); conditions.push('f.ReportDate <= @to'); }

  const result = await request.query(`
    SELECT ${dim.select}, SUM(f.MeasureValue) AS Total
    FROM dbo.Fact_Sales f ${dim.join}
    WHERE ${conditions.join(' AND ')}
    GROUP BY ${dim.group} ORDER BY Total DESC`);
  res.json({ dimension, measure, rows: result.recordset });
});

module.exports = router;
