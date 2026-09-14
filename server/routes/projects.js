const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth, requirePerm, logAction } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT p.*, e.FullName AS AssignedSalesName
    FROM dbo.Projects p LEFT JOIN dbo.Employees e ON e.EmployeeId = p.AssignedSalesId
    ORDER BY p.CreatedAt DESC`);
  res.json(result.recordset);
});

router.post('/', requirePerm('projectManage'), async (req, res) => {
  const { projectName, endCustomerName, estimatedValue, stage, expectedCloseDate, competitorNotes, assignedSalesId } = req.body || {};
  if (!projectName) return res.status(400).json({ error: 'Thiếu tên dự án' });

  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const result = await new sql.Request(tx)
      .input('name', sql.NVarChar, projectName)
      .input('endCustomer', sql.NVarChar, endCustomerName || null)
      .input('estimatedValue', sql.Decimal(18, 2), estimatedValue || null)
      .input('stage', sql.NVarChar, stage || 'LEAD')
      .input('expectedCloseDate', sql.Date, expectedCloseDate || null)
      .input('notes', sql.NVarChar, competitorNotes || null)
      .input('assignedSalesId', sql.Int, assignedSalesId || null)
      .query(`INSERT INTO dbo.Projects (ProjectName, EndCustomerName, EstimatedValue, Stage, ExpectedCloseDate, CompetitorNotes, AssignedSalesId)
              OUTPUT INSERTED.* VALUES (@name, @endCustomer, @estimatedValue, @stage, @expectedCloseDate, @notes, @assignedSalesId)`);

    const project = result.recordset[0];
    if (assignedSalesId) {
      await new sql.Request(tx)
        .input('projectId', sql.Int, project.ProjectId).input('salesId', sql.Int, assignedSalesId)
        .query(`INSERT INTO dbo.ProjectSalesAssignmentHistory (ProjectId, SalesEmployeeId, StartDate)
                VALUES (@projectId, @salesId, CAST(SYSUTCDATETIME() AS DATE))`);
    }
    await tx.commit();
    await logAction(req, 'CREATE', 'Project', project.ProjectId, req.body);
    res.status(201).json(project);
  } catch (err) {
    await tx.rollback();
    throw err;
  }
});

router.put('/:id', requirePerm('projectManage'), async (req, res) => {
  const { projectName, endCustomerName, estimatedValue, stage, expectedCloseDate, competitorNotes, assignedSalesId, lostReason } = req.body || {};
  const pool = await getPool();
  const current = await pool.request().input('id', sql.Int, req.params.id)
    .query('SELECT AssignedSalesId FROM dbo.Projects WHERE ProjectId = @id');
  if (!current.recordset[0]) return res.status(404).json({ error: 'Không tìm thấy dự án' });
  const salesChanged = assignedSalesId != null && assignedSalesId !== current.recordset[0].AssignedSalesId;

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx)
      .input('id', sql.Int, req.params.id)
      .input('name', sql.NVarChar, projectName)
      .input('endCustomer', sql.NVarChar, endCustomerName || null)
      .input('estimatedValue', sql.Decimal(18, 2), estimatedValue || null)
      .input('stage', sql.NVarChar, stage || 'LEAD')
      .input('expectedCloseDate', sql.Date, expectedCloseDate || null)
      .input('notes', sql.NVarChar, competitorNotes || null)
      .input('assignedSalesId', sql.Int, assignedSalesId || null)
      .input('lostReason', sql.NVarChar, lostReason || null)
      .query(`UPDATE dbo.Projects SET ProjectName=@name, EndCustomerName=@endCustomer, EstimatedValue=@estimatedValue,
              Stage=@stage, ExpectedCloseDate=@expectedCloseDate, CompetitorNotes=@notes,
              AssignedSalesId=@assignedSalesId, LostReason=@lostReason WHERE ProjectId=@id`);

    if (salesChanged) {
      await new sql.Request(tx).input('id', sql.Int, req.params.id)
        .query(`UPDATE dbo.ProjectSalesAssignmentHistory SET EndDate = CAST(SYSUTCDATETIME() AS DATE)
                WHERE ProjectId=@id AND EndDate IS NULL`);
      await new sql.Request(tx).input('projectId', sql.Int, req.params.id).input('salesId', sql.Int, assignedSalesId)
        .query(`INSERT INTO dbo.ProjectSalesAssignmentHistory (ProjectId, SalesEmployeeId, StartDate)
                VALUES (@projectId, @salesId, CAST(SYSUTCDATETIME() AS DATE))`);
    }

    await tx.commit();
    await logAction(req, 'UPDATE', 'Project', req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    await tx.rollback();
    throw err;
  }
});

// --- Báo giá dự án ---

router.get('/:id/quotes', async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().input('id', sql.Int, req.params.id)
    .query('SELECT * FROM dbo.ProjectQuotes WHERE ProjectId = @id ORDER BY QuoteVersion DESC');
  res.json(result.recordset);
});

router.post('/:id/quotes', requirePerm('projectManage'), async (req, res) => {
  const { totalAmount, status } = req.body || {};
  if (totalAmount == null) return res.status(400).json({ error: 'Thiếu tổng giá trị báo giá' });

  const pool = await getPool();
  const nextVersion = await pool.request().input('id', sql.Int, req.params.id)
    .query('SELECT ISNULL(MAX(QuoteVersion), 0) + 1 AS NextVersion FROM dbo.ProjectQuotes WHERE ProjectId = @id');

  const result = await pool.request()
    .input('projectId', sql.Int, req.params.id)
    .input('version', sql.Int, nextVersion.recordset[0].NextVersion)
    .input('total', sql.Decimal(18, 2), totalAmount)
    .input('status', sql.NVarChar, status || 'DRAFT')
    .query(`INSERT INTO dbo.ProjectQuotes (ProjectId, QuoteVersion, TotalAmount, Status)
            OUTPUT INSERTED.* VALUES (@projectId, @version, @total, @status)`);
  await logAction(req, 'CREATE', 'ProjectQuote', result.recordset[0].QuoteId, req.body);
  res.status(201).json(result.recordset[0]);
});

router.put('/:id/quotes/:quoteId', requirePerm('projectManage'), async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'Thiếu trạng thái báo giá' });
  const pool = await getPool();
  await pool.request().input('id', sql.Int, req.params.quoteId).input('status', sql.NVarChar, status)
    .query('UPDATE dbo.ProjectQuotes SET Status = @status WHERE QuoteId = @id');
  await logAction(req, 'UPDATE', 'ProjectQuote', req.params.quoteId, req.body);
  res.json({ ok: true });
});

module.exports = router;
