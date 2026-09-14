const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth, requirePerm, logAction } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/interactions', async (req, res) => {
  const { dealerId, projectId } = req.query;
  const pool = await getPool();
  const request = pool.request();
  const conditions = [];
  if (dealerId) { request.input('dealerId', sql.Int, dealerId); conditions.push('i.DealerId = @dealerId'); }
  if (projectId) { request.input('projectId', sql.Int, projectId); conditions.push('i.ProjectId = @projectId'); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await request.query(`
    SELECT i.*, e.FullName AS SalesEmployeeName, d.DealerName, p.ProjectName
    FROM dbo.SalesInteractions i
    JOIN dbo.Employees e ON e.EmployeeId = i.SalesEmployeeId
    LEFT JOIN dbo.Dealers d ON d.DealerId = i.DealerId
    LEFT JOIN dbo.Projects p ON p.ProjectId = i.ProjectId
    ${where}
    ORDER BY i.CreatedAt DESC`);
  res.json(result.recordset);
});

router.post('/interactions', requirePerm('salesOrderCreate'), async (req, res) => {
  const { salesEmployeeId, customerType, dealerId, projectId, interactionType, summary, nextActionDate } = req.body || {};
  if (!salesEmployeeId || !customerType || !interactionType) {
    return res.status(400).json({ error: 'Thiếu nhân viên phụ trách/loại khách hàng/loại tương tác' });
  }
  if (customerType === 'DEALER' && !dealerId) return res.status(400).json({ error: 'Thiếu đại lý' });
  if (customerType === 'PROJECT' && !projectId) return res.status(400).json({ error: 'Thiếu dự án' });

  const pool = await getPool();
  const result = await pool.request()
    .input('salesEmployeeId', sql.Int, salesEmployeeId)
    .input('customerType', sql.NVarChar, customerType)
    .input('dealerId', sql.Int, dealerId || null)
    .input('projectId', sql.Int, projectId || null)
    .input('interactionType', sql.NVarChar, interactionType)
    .input('summary', sql.NVarChar, summary || null)
    .input('nextActionDate', sql.Date, nextActionDate || null)
    .query(`INSERT INTO dbo.SalesInteractions (SalesEmployeeId, CustomerType, DealerId, ProjectId, InteractionType, Summary, NextActionDate)
            OUTPUT INSERTED.* VALUES (@salesEmployeeId, @customerType, @dealerId, @projectId, @interactionType, @summary, @nextActionDate)`);
  await logAction(req, 'CREATE', 'SalesInteraction', result.recordset[0].InteractionId, req.body);
  res.status(201).json(result.recordset[0]);
});

module.exports = router;
