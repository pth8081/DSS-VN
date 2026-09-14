const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth, requirePerm, logAction } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requirePerm('reportViewFinance'));

router.get('/sync-queue', async (req, res) => {
  const { status } = req.query;
  const pool = await getPool();
  const request = pool.request();
  let where = '';
  if (status) { request.input('status', sql.NVarChar, status); where = 'WHERE Status = @status'; }
  const result = await request.query(`SELECT TOP 500 * FROM dbo.AccountingSyncQueue ${where} ORDER BY CreatedAt DESC`);
  res.json(result.recordset);
});

function csvEscape(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;   // chống Formula Injection khi mở bằng Excel
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Xuất CSV cho các hoá đơn PENDING để kế toán tự nhập tay (ExcelExportAdapter
// — Mục 15.2), rồi đánh dấu SENT. Không gửi gì ra ngoài hệ thống, chỉ đóng
// dấu hàng đợi để không xuất trùng lần sau.
router.post('/sync-queue/export-csv', async (req, res) => {
  const pool = await getPool();
  const pending = await pool.request().input('status', sql.NVarChar, 'PENDING').input('type', sql.NVarChar, 'INVOICE')
    .query(`SELECT * FROM dbo.AccountingSyncQueue WHERE Status = @status AND EntryType = @type ORDER BY QueueId`);

  if (!pending.recordset.length) return res.status(400).json({ error: 'Không có hoá đơn nào đang chờ đồng bộ' });

  const rows = [['QueueId', 'OrderCode', 'DealerCode', 'DealerName', 'TotalAmount', 'PaymentTermDays', 'IssuedAt']];
  for (const row of pending.recordset) {
    let payload = {};
    try { payload = JSON.parse(row.PayloadJson); } catch { payload = {}; }
    rows.push([row.QueueId, payload.orderCode, payload.dealerCode, payload.dealerName, payload.totalAmount, payload.paymentTermDays, payload.issuedAt]);
  }
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');

  const ids = pending.recordset.map((r) => r.QueueId);
  const idParams = ids.map((id, i) => `@id${i}`).join(',');
  const updateRequest = pool.request();
  ids.forEach((id, i) => updateRequest.input(`id${i}`, sql.BigInt, id));
  await updateRequest.query(`UPDATE dbo.AccountingSyncQueue SET Status='SENT', SentAt=SYSUTCDATETIME() WHERE QueueId IN (${idParams})`);

  await logAction(req, 'EXPORT_CSV', 'AccountingSyncQueue', null, { count: ids.length });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="hoa-don-ke-toan-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + csv);
});

module.exports = router;
