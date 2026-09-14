const express = require('express');
const rateLimit = require('express-rate-limit');
const { sql, getPool } = require('../db');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau' },
});

async function logExternalCall(action, detail, ip) {
  try {
    const pool = await getPool();
    await pool.request()
      .input('username', sql.NVarChar, '(external-accounting-api)')
      .input('action', sql.NVarChar, action)
      .input('detailJson', sql.NVarChar(sql.MAX), JSON.stringify(detail))
      .input('ip', sql.NVarChar, ip || null)
      .query(`INSERT INTO dbo.SystemLog (Username, Action, EntityType, DetailJson, IPAddress)
              VALUES (@username, @action, 'AccountingApi', @detailJson, @ip)`);
  } catch (err) {
    console.error('Ghi SystemLog cho external API thất bại:', err.message);
  }
}

// Xác nhận đã thu tiền từ đại lý — chiều ngược lại của luồng kế toán (Mục 8.2):
// kế toán/phần mềm ngoài gọi vào đây sau khi ghi nhận thanh toán ở hệ thống
// của họ. Bảo mật: API Key riêng (bắt buộc cấu hình ACCOUNTING_API_KEY, endpoint
// tự tắt nếu chưa cấu hình) + IP allowlist tuỳ chọn (ACCOUNTING_API_IP_ALLOWLIST)
// + rate limit + ghi log MỌI lượt gọi (thành công lẫn thất bại).
router.post('/payment-confirmations', limiter, async (req, res) => {
  if (!process.env.ACCOUNTING_API_KEY) {
    return res.status(503).json({ error: 'API kế toán chưa được cấu hình trên máy chủ này' });
  }

  const allowlist = (process.env.ACCOUNTING_API_IP_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowlist.length && !allowlist.includes(req.ip)) {
    await logExternalCall('PAYMENT_CONFIRM_DENIED_IP', { ip: req.ip }, req.ip);
    return res.status(403).json({ error: 'IP không được phép gọi API này' });
  }

  const apiKey = req.get('X-API-Key');
  if (apiKey !== process.env.ACCOUNTING_API_KEY) {
    await logExternalCall('PAYMENT_CONFIRM_DENIED_KEY', {}, req.ip);
    return res.status(401).json({ error: 'API Key không hợp lệ' });
  }

  const { dealerCode, amount, paymentDate, referenceNo } = req.body || {};
  if (!dealerCode || !amount) return res.status(400).json({ error: 'Thiếu dealerCode hoặc amount' });

  const pool = await getPool();
  const dealer = await pool.request().input('code', sql.NVarChar, dealerCode)
    .query('SELECT DealerId FROM dbo.Dealers WHERE DealerCode = @code');
  if (!dealer.recordset[0]) {
    await logExternalCall('PAYMENT_CONFIRM_UNKNOWN_DEALER', { dealerCode }, req.ip);
    return res.status(404).json({ error: 'Không tìm thấy đại lý theo dealerCode' });
  }

  // Amount lưu ÂM trong sổ cái (EntryType=PAYMENT) vì Công nợ hiện tại = SUM(Amount)
  // và hoá đơn (INVOICE) lưu dương — thanh toán phải làm giảm tổng.
  await pool.request()
    .input('dealerId', sql.Int, dealer.recordset[0].DealerId)
    .input('amount', sql.Decimal(18, 2), -Math.abs(Number(amount)))
    .input('entryDate', sql.Date, paymentDate || null)
    .input('note', sql.NVarChar, referenceNo || null)
    .query(`INSERT INTO dbo.DealerLedger (DealerId, EntryType, Amount, RefType, Note, EntryDate)
            VALUES (@dealerId, 'PAYMENT', @amount, 'ExternalPayment', @note,
                    COALESCE(@entryDate, CAST(SYSUTCDATETIME() AS DATE)))`);

  await logExternalCall('PAYMENT_CONFIRM_OK', { dealerCode, amount, referenceNo }, req.ip);
  res.status(201).json({ ok: true });
});

module.exports = router;
