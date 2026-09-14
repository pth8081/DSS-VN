const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth, requirePerm, logAction } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Đổi Tier/CreditLimitOverride/PaymentTermDaysOverride cần quyền riêng, hạn chế
// hơn quyền quản lý đại lý thông thường (nguyên tắc phân quyền Module 13).
const CREDIT_FIELDS = ['tierId', 'creditLimitOverride', 'paymentTermDaysOverride'];
function touchesCreditFields(body) {
  return CREDIT_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(body, f));
}
function canOverrideCredit(user) {
  return user.isAdmin || user.perms.dealerCreditOverride === true;
}

router.get('/', async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT d.*, t.TierName, t.DefaultCreditLimit, t.DefaultPaymentTermDays, t.DefaultMaxDiscountPct,
           r.RegionName, e.FullName AS AssignedSalesName,
           COALESCE(d.CreditLimitOverride, t.DefaultCreditLimit, 0) AS EffectiveCreditLimit,
           COALESCE(d.PaymentTermDaysOverride, t.DefaultPaymentTermDays, 0) AS EffectivePaymentTermDays,
           ISNULL(ledger.CurrentDebt, 0) AS CurrentDebt,
           CASE WHEN ISNULL(ledger.CurrentDebt, 0) > COALESCE(d.CreditLimitOverride, t.DefaultCreditLimit, 0)
                THEN 1 ELSE 0 END AS OverCredit
    FROM dbo.Dealers d
    LEFT JOIN dbo.DealerTiers t ON t.TierId = d.TierId
    LEFT JOIN dbo.Regions r ON r.RegionId = d.RegionId
    LEFT JOIN dbo.Employees e ON e.EmployeeId = d.AssignedSalesId
    OUTER APPLY (SELECT SUM(Amount) AS CurrentDebt FROM dbo.DealerLedger WHERE DealerId = d.DealerId) ledger
    ORDER BY d.DealerName`);
  res.json(result.recordset);
});

router.post('/', requirePerm('dealerManage'), async (req, res) => {
  const { dealerCode, dealerName, taxCode, regionId, assignedSalesId } = req.body || {};
  if (!dealerCode || !dealerName) return res.status(400).json({ error: 'Thiếu mã hoặc tên đại lý' });
  if (touchesCreditFields(req.body) && !canOverrideCredit(req.user)) {
    return res.status(403).json({ error: 'Không có quyền đặt hạng/hạn mức/số ngày công nợ đại lý' });
  }

  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const result = await new sql.Request(tx)
      .input('code', sql.NVarChar, dealerCode)
      .input('name', sql.NVarChar, dealerName)
      .input('taxCode', sql.NVarChar, taxCode || null)
      .input('tierId', sql.Int, req.body.tierId || null)
      .input('creditLimitOverride', sql.Decimal(18, 2), req.body.creditLimitOverride ?? null)
      .input('paymentTermDaysOverride', sql.Int, req.body.paymentTermDaysOverride ?? null)
      .input('regionId', sql.Int, regionId || null)
      .input('assignedSalesId', sql.Int, assignedSalesId || null)
      .query(`INSERT INTO dbo.Dealers (DealerCode, DealerName, TaxCode, TierId, CreditLimitOverride,
                PaymentTermDaysOverride, RegionId, AssignedSalesId)
              OUTPUT INSERTED.*
              VALUES (@code, @name, @taxCode, @tierId, @creditLimitOverride, @paymentTermDaysOverride, @regionId, @assignedSalesId)`);

    const dealer = result.recordset[0];
    if (assignedSalesId) {
      await new sql.Request(tx)
        .input('dealerId', sql.Int, dealer.DealerId).input('salesId', sql.Int, assignedSalesId)
        .query(`INSERT INTO dbo.DealerSalesAssignmentHistory (DealerId, SalesEmployeeId, StartDate)
                VALUES (@dealerId, @salesId, CAST(SYSUTCDATETIME() AS DATE))`);
    }
    await tx.commit();
    await logAction(req, 'CREATE', 'Dealer', dealer.DealerId, req.body);
    res.status(201).json(dealer);
  } catch (err) {
    await tx.rollback();
    if (err.number === 2627) return res.status(409).json({ error: 'Mã đại lý hoặc mã số thuế đã tồn tại' });
    throw err;
  }
});

router.put('/:id', requirePerm('dealerManage'), async (req, res) => {
  const { dealerName, taxCode, regionId, assignedSalesId, status } = req.body || {};
  if (touchesCreditFields(req.body) && !canOverrideCredit(req.user)) {
    return res.status(403).json({ error: 'Không có quyền đổi hạng/hạn mức/số ngày công nợ đại lý' });
  }

  const pool = await getPool();
  const current = await pool.request().input('id', sql.Int, req.params.id)
    .query('SELECT TierId, CreditLimitOverride, AssignedSalesId FROM dbo.Dealers WHERE DealerId = @id');
  if (!current.recordset[0]) return res.status(404).json({ error: 'Không tìm thấy đại lý' });
  const salesChanged = assignedSalesId != null && assignedSalesId !== current.recordset[0].AssignedSalesId;

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const request = new sql.Request(tx)
      .input('id', sql.Int, req.params.id)
      .input('name', sql.NVarChar, dealerName)
      .input('taxCode', sql.NVarChar, taxCode || null)
      .input('regionId', sql.Int, regionId || null)
      .input('assignedSalesId', sql.Int, assignedSalesId || null)
      .input('status', sql.NVarChar, status || 'ACTIVE');

    let setClause = `DealerName=@name, TaxCode=@taxCode, RegionId=@regionId, AssignedSalesId=@assignedSalesId, Status=@status`;
    if (touchesCreditFields(req.body)) {
      request.input('tierId', sql.Int, req.body.tierId || null);
      request.input('creditLimitOverride', sql.Decimal(18, 2), req.body.creditLimitOverride ?? null);
      request.input('paymentTermDaysOverride', sql.Int, req.body.paymentTermDaysOverride ?? null);
      setClause += `, TierId=@tierId, CreditLimitOverride=@creditLimitOverride, PaymentTermDaysOverride=@paymentTermDaysOverride`;
    }
    await request.query(`UPDATE dbo.Dealers SET ${setClause} WHERE DealerId=@id`);

    if (salesChanged) {
      await new sql.Request(tx).input('id', sql.Int, req.params.id)
        .query(`UPDATE dbo.DealerSalesAssignmentHistory SET EndDate = CAST(SYSUTCDATETIME() AS DATE)
                WHERE DealerId=@id AND EndDate IS NULL`);
      await new sql.Request(tx).input('dealerId', sql.Int, req.params.id).input('salesId', sql.Int, assignedSalesId)
        .query(`INSERT INTO dbo.DealerSalesAssignmentHistory (DealerId, SalesEmployeeId, StartDate)
                VALUES (@dealerId, @salesId, CAST(SYSUTCDATETIME() AS DATE))`);
    }

    await tx.commit();
    await logAction(req, 'UPDATE', 'Dealer', req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    await tx.rollback();
    throw err;
  }
});

// --- Lịch sử xét duyệt hạn mức (Mục 15.1) ---

router.get('/:id/credit-reviews', requirePerm('dealerCreditOverride'), async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().input('id', sql.Int, req.params.id)
    .query('SELECT * FROM dbo.DealerCreditReviews WHERE DealerId = @id ORDER BY ReviewDate DESC');
  res.json(result.recordset);
});

router.post('/:id/credit-reviews', requirePerm('dealerCreditOverride'), async (req, res) => {
  const { oldLimit, proposedLimit, onTimePaymentRatio, decision } = req.body || {};
  if (oldLimit == null || proposedLimit == null) return res.status(400).json({ error: 'Thiếu hạn mức cũ/đề xuất' });

  const pool = await getPool();
  const result = await pool.request()
    .input('dealerId', sql.Int, req.params.id)
    .input('oldLimit', sql.Decimal(18, 2), oldLimit)
    .input('proposedLimit', sql.Decimal(18, 2), proposedLimit)
    .input('ratio', sql.Decimal(5, 2), onTimePaymentRatio ?? null)
    .input('decision', sql.NVarChar, decision || 'DEFERRED')
    .input('approvedBy', sql.NVarChar, req.user.username)
    .query(`INSERT INTO dbo.DealerCreditReviews (DealerId, OldLimit, ProposedLimit, OnTimePaymentRatio, Decision, ApprovedBy)
            OUTPUT INSERTED.* VALUES (@dealerId, @oldLimit, @proposedLimit, @ratio, @decision, @approvedBy)`);

  if (decision === 'APPROVED') {
    await pool.request().input('id', sql.Int, req.params.id).input('limit', sql.Decimal(18, 2), proposedLimit)
      .query('UPDATE dbo.Dealers SET CreditLimitOverride = @limit WHERE DealerId = @id');
  }

  await logAction(req, 'CREATE', 'DealerCreditReview', result.recordset[0].ReviewId, req.body);
  res.status(201).json(result.recordset[0]);
});

// Đại lý đủ điều kiện xét tăng hạn mức: onboard >= 3 tháng, chưa từng xét
// hoặc lần xét gần nhất đã quá 3 tháng (Mục 15.1) — chỉ liệt kê để admin tự
// xem xét, KHÔNG tự động tăng hạn mức.
router.get('/credit-review-candidates', requirePerm('dealerCreditOverride'), async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT d.DealerId, d.DealerCode, d.DealerName, d.OnboardedAt,
           COALESCE(d.CreditLimitOverride, t.DefaultCreditLimit, 0) AS CurrentLimit,
           lastReview.LastReviewDate
    FROM dbo.Dealers d
    LEFT JOIN dbo.DealerTiers t ON t.TierId = d.TierId
    OUTER APPLY (SELECT MAX(ReviewDate) AS LastReviewDate FROM dbo.DealerCreditReviews WHERE DealerId = d.DealerId) lastReview
    WHERE d.Status = 'ACTIVE'
      AND d.OnboardedAt <= DATEADD(MONTH, -3, CAST(SYSUTCDATETIME() AS DATE))
      AND (lastReview.LastReviewDate IS NULL OR lastReview.LastReviewDate <= DATEADD(MONTH, -3, CAST(SYSUTCDATETIME() AS DATE)))
    ORDER BY d.OnboardedAt`);
  res.json(result.recordset);
});

// --- Sổ cái công nợ (Module 8) — append-only, chỉ đọc qua route này ---

router.get('/:id/ledger', requirePerm('reportViewFinance'), async (req, res) => {
  const pool = await getPool();
  const entries = await pool.request().input('id', sql.Int, req.params.id)
    .query('SELECT * FROM dbo.DealerLedger WHERE DealerId = @id ORDER BY EntryDate DESC, LedgerId DESC');
  const debt = await pool.request().input('id', sql.Int, req.params.id)
    .query('SELECT ISNULL(SUM(Amount), 0) AS CurrentDebt FROM dbo.DealerLedger WHERE DealerId = @id');
  res.json({ currentDebt: debt.recordset[0].CurrentDebt, entries: entries.recordset });
});

module.exports = router;
