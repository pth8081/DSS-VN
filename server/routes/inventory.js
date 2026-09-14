const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth, requirePerm, logAction } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/balances', async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT b.ProductId, b.WarehouseId, b.OnHandQty, b.ReservedQty, (b.OnHandQty - b.ReservedQty) AS AvailableQty,
           b.AvgCost, p.SKU, p.ProductName, p.UnitOfMeasure, w.WarehouseName
    FROM dbo.InventoryBalances b
    JOIN dbo.Products p ON p.ProductId = b.ProductId
    JOIN dbo.Warehouses w ON w.WarehouseId = b.WarehouseId
    ORDER BY p.ProductName, w.WarehouseName`);
  res.json(result.recordset);
});

router.get('/transactions', async (req, res) => {
  const { productId, warehouseId } = req.query;
  const pool = await getPool();
  const request = pool.request();
  const conditions = [];
  if (productId) { request.input('productId', sql.Int, productId); conditions.push('t.ProductId = @productId'); }
  if (warehouseId) { request.input('warehouseId', sql.Int, warehouseId); conditions.push('t.WarehouseId = @warehouseId'); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await request.query(`
    SELECT TOP 500 t.*, p.SKU, p.ProductName, w.WarehouseName
    FROM dbo.InventoryTransactions t
    JOIN dbo.Products p ON p.ProductId = t.ProductId
    JOIN dbo.Warehouses w ON w.WarehouseId = t.WarehouseId
    ${where}
    ORDER BY t.CreatedAt DESC`);
  res.json(result.recordset);
});

function handleProcError(err, res) {
  // Lỗi nghiệp vụ ném bằng THROW trong proc (mã 50000+) — trả thông điệp tiếng Việt gốc cho người dùng.
  if (err.number >= 50000 && err.number < 60000) {
    return res.status(400).json({ error: err.message });
  }
  throw err;
}

router.post('/import', requirePerm('warehouseManage'), async (req, res) => {
  const { productId, warehouseId, quantity, unitCost, note } = req.body || {};
  if (!productId || !warehouseId || !quantity || unitCost == null) {
    return res.status(400).json({ error: 'Thiếu thông tin sản phẩm/kho/số lượng/đơn giá' });
  }
  try {
    const pool = await getPool();
    await pool.request()
      .input('ProductId', sql.Int, productId)
      .input('WarehouseId', sql.Int, warehouseId)
      .input('Qty', sql.Decimal(18, 2), quantity)
      .input('UnitCost', sql.Decimal(18, 4), unitCost)
      .input('Note', sql.NVarChar, note || null)
      .input('CreatedBy', sql.NVarChar, req.user.username)
      .execute('dbo.ImportStock');
    await logAction(req, 'IMPORT_STOCK', 'Product', productId, req.body);
    res.json({ ok: true });
  } catch (err) {
    handleProcError(err, res);
  }
});

router.post('/adjust', requirePerm('warehouseManage'), async (req, res) => {
  const { productId, warehouseId, newOnHandQty, note } = req.body || {};
  if (!productId || !warehouseId || newOnHandQty == null) {
    return res.status(400).json({ error: 'Thiếu thông tin sản phẩm/kho/số lượng mới' });
  }
  try {
    const pool = await getPool();
    await pool.request()
      .input('ProductId', sql.Int, productId)
      .input('WarehouseId', sql.Int, warehouseId)
      .input('NewOnHandQty', sql.Decimal(18, 2), newOnHandQty)
      .input('Note', sql.NVarChar, note || null)
      .input('CreatedBy', sql.NVarChar, req.user.username)
      .execute('dbo.AdjustStock');
    await logAction(req, 'ADJUST_STOCK', 'Product', productId, req.body);
    res.json({ ok: true });
  } catch (err) {
    handleProcError(err, res);
  }
});

router.post('/transfer', requirePerm('warehouseManage'), async (req, res) => {
  const { productId, fromWarehouseId, toWarehouseId, quantity, note } = req.body || {};
  if (!productId || !fromWarehouseId || !toWarehouseId || !quantity) {
    return res.status(400).json({ error: 'Thiếu thông tin sản phẩm/kho nguồn/kho đích/số lượng' });
  }
  try {
    const pool = await getPool();
    await pool.request()
      .input('ProductId', sql.Int, productId)
      .input('FromWarehouseId', sql.Int, fromWarehouseId)
      .input('ToWarehouseId', sql.Int, toWarehouseId)
      .input('Qty', sql.Decimal(18, 2), quantity)
      .input('Note', sql.NVarChar, note || null)
      .input('CreatedBy', sql.NVarChar, req.user.username)
      .execute('dbo.TransferStock');
    await logAction(req, 'TRANSFER_STOCK', 'Product', productId, req.body);
    res.json({ ok: true });
  } catch (err) {
    handleProcError(err, res);
  }
});

module.exports = router;
