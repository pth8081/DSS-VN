const { sql, getPool } = require('../db');

// Cron quét mỗi giờ (Mục 15.4 tài liệu thiết kế): đơn hàng CHỜ DUYỆT quá hạn
// giữ hàng tự chuyển CANCELLED_EXPIRED + nhả ReservedQty, không cần ai duyệt.
async function runExpirySweep() {
  try {
    const pool = await getPool();
    const expired = await pool.request().query(`
      SELECT OrderId FROM dbo.SalesOrders
      WHERE Status = 'PENDING_APPROVAL' AND ReservationExpiresAt < SYSUTCDATETIME()`);

    for (const row of expired.recordset) {
      try {
        await pool.request().input('OrderId', sql.BigInt, row.OrderId).input('Expired', sql.Bit, true)
          .execute('dbo.CancelSalesOrder');
        console.log(`Đơn hàng #${row.OrderId} hết hạn giữ hàng — đã tự hủy và nhả tồn kho`);
      } catch (err) {
        console.error(`Lỗi tự hủy đơn hàng #${row.OrderId} khi hết hạn giữ hàng:`, err.message);
      }
    }
  } catch (err) {
    console.error('Lỗi quét đơn hàng hết hạn giữ hàng:', err.message);
  }
}

module.exports = { runExpirySweep };
