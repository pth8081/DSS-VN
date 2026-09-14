const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth, requirePerm, logAction } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function handleProcError(err, res) {
  if (err.number >= 50000 && err.number < 60000) return res.status(400).json({ error: err.message });
  throw err;
}

router.get('/', async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT c.*, d.DealerName, p.ProjectName FROM dbo.Contracts c
    LEFT JOIN dbo.Dealers d ON d.DealerId = c.DealerId
    LEFT JOIN dbo.Projects p ON p.ProjectId = c.ProjectId
    ORDER BY c.CreatedAt DESC`);
  res.json(result.recordset);
});

router.post('/', requirePerm('contractManage'), async (req, res) => {
  const { contractCode, contractType, dealerId, projectId, contractName, totalValue, effectiveFrom, effectiveTo } = req.body || {};
  if (!contractCode || !contractType || !contractName || !effectiveFrom) {
    return res.status(400).json({ error: 'Thiếu mã/loại/tên hợp đồng hoặc ngày hiệu lực' });
  }
  if (contractType === 'DEALER_FRAMEWORK' && !dealerId) return res.status(400).json({ error: 'Hợp đồng khung Đại lý cần chọn đại lý' });
  if (contractType === 'PROJECT' && !projectId) return res.status(400).json({ error: 'Hợp đồng theo Dự án cần chọn dự án' });

  const pool = await getPool();
  try {
    const result = await pool.request()
      .input('code', sql.NVarChar, contractCode)
      .input('type', sql.NVarChar, contractType)
      .input('dealerId', sql.Int, dealerId || null)
      .input('projectId', sql.Int, projectId || null)
      .input('name', sql.NVarChar, contractName)
      .input('totalValue', sql.Decimal(18, 2), totalValue || null)
      .input('from', sql.Date, effectiveFrom)
      .input('to', sql.Date, effectiveTo || null)
      .input('createdBy', sql.NVarChar, req.user.username)
      .query(`INSERT INTO dbo.Contracts (ContractCode, ContractType, DealerId, ProjectId, ContractName, TotalValue, EffectiveFrom, EffectiveTo, CreatedBy)
              OUTPUT INSERTED.* VALUES (@code, @type, @dealerId, @projectId, @name, @totalValue, @from, @to, @createdBy)`);
    await logAction(req, 'CREATE', 'Contract', result.recordset[0].ContractId, req.body);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627) return res.status(409).json({ error: 'Mã hợp đồng đã tồn tại' });
    throw err;
  }
});

router.put('/:id', requirePerm('contractManage'), async (req, res) => {
  const { contractName, totalValue, effectiveTo, status } = req.body || {};
  const pool = await getPool();
  await pool.request()
    .input('id', sql.Int, req.params.id)
    .input('name', sql.NVarChar, contractName)
    .input('totalValue', sql.Decimal(18, 2), totalValue || null)
    .input('to', sql.Date, effectiveTo || null)
    .input('status', sql.NVarChar, status || 'ACTIVE')
    .query('UPDATE dbo.Contracts SET ContractName=@name, TotalValue=@totalValue, EffectiveTo=@to, Status=@status WHERE ContractId=@id');
  await logAction(req, 'UPDATE', 'Contract', req.params.id, req.body);
  res.json({ ok: true });
});

// --- Phụ lục thanh toán ---

router.get('/:id/milestones', async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().input('id', sql.Int, req.params.id)
    .query('SELECT * FROM dbo.ContractPaymentMilestones WHERE ContractId = @id ORDER BY DisplayOrder, MilestoneId');
  res.json(result.recordset);
});

router.post('/:id/milestones', requirePerm('contractManage'), async (req, res) => {
  const { milestoneName, milestoneType, amount, dueDate, displayOrder } = req.body || {};
  if (!milestoneName || amount == null) return res.status(400).json({ error: 'Thiếu tên hoặc số tiền phụ lục' });

  const pool = await getPool();
  const result = await pool.request()
    .input('contractId', sql.Int, req.params.id)
    .input('name', sql.NVarChar, milestoneName)
    .input('type', sql.NVarChar, milestoneType || 'OTHER')
    .input('amount', sql.Decimal(18, 2), amount)
    .input('dueDate', sql.Date, dueDate || null)
    .input('order', sql.Int, displayOrder || 0)
    .query(`INSERT INTO dbo.ContractPaymentMilestones (ContractId, MilestoneName, MilestoneType, Amount, DueDate, DisplayOrder)
            OUTPUT INSERTED.* VALUES (@contractId, @name, @type, @amount, @dueDate, @order)`);
  await logAction(req, 'CREATE', 'ContractPaymentMilestone', result.recordset[0].MilestoneId, req.body);
  res.status(201).json(result.recordset[0]);
});

// Bước 1: Duyệt chi — xác nhận nội bộ phụ lục hợp lệ, sẵn sàng xuất hoá đơn.
router.post('/milestones/:milestoneId/approve', requirePerm('contractManage'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('MilestoneId', sql.Int, req.params.milestoneId).input('UserId', sql.Int, req.user.userId)
      .execute('dbo.ApproveContractMilestone');
    await logAction(req, 'APPROVE_MILESTONE', 'ContractPaymentMilestone', req.params.milestoneId, null);
    res.json({ ok: true });
  } catch (err) {
    handleProcError(err, res);
  }
});

// Bước 2: Xác nhận đã thu tiền — chỉ bước này mới ghi nhận vào DealerLedger.
router.post('/milestones/:milestoneId/confirm-paid', requirePerm('reportViewFinance'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('MilestoneId', sql.Int, req.params.milestoneId).execute('dbo.ConfirmContractMilestonePaid');
    await logAction(req, 'CONFIRM_PAID', 'ContractPaymentMilestone', req.params.milestoneId, null);
    res.json({ ok: true });
  } catch (err) {
    handleProcError(err, res);
  }
});

module.exports = router;
