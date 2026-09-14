const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth, requirePerm, logAction } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function handleProcError(err, res) {
  if (err.number >= 50000 && err.number < 60000) return res.status(400).json({ error: err.message });
  throw err;
}

// --- Kênh bán hàng ---

router.get('/channels', async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query('SELECT * FROM dbo.SalesChannels ORDER BY ChannelName');
  res.json(result.recordset);
});

router.post('/channels', requirePerm('salesConfigManage'), async (req, res) => {
  const { channelName, channelType, defaultReservationHours } = req.body || {};
  if (!channelName || !channelType) return res.status(400).json({ error: 'Thiếu tên hoặc loại kênh' });

  const pool = await getPool();
  const result = await pool.request()
    .input('name', sql.NVarChar, channelName)
    .input('type', sql.NVarChar, channelType)
    .input('hours', sql.Decimal(6, 2), defaultReservationHours ?? 72)
    .query(`INSERT INTO dbo.SalesChannels (ChannelName, ChannelType, DefaultReservationHours)
            OUTPUT INSERTED.* VALUES (@name, @type, @hours)`);
  await logAction(req, 'CREATE', 'SalesChannel', result.recordset[0].ChannelId, req.body);
  res.status(201).json(result.recordset[0]);
});

// Tra giá niêm yết + %CK tối đa áp dụng cho 1 sản phẩm theo đúng hạng đại lý
// (hoặc bảng giá chung nếu không có đại lý — vd Retail) — nguyên tắc Omnichannel:
// 1 nguồn giá duy nhất cho mọi kênh, không để mỗi kênh tự tra giá riêng.
router.get('/price-lookup', async (req, res) => {
  const { productId, dealerId } = req.query;
  if (!productId) return res.status(400).json({ error: 'Thiếu productId' });

  const pool = await getPool();
  const request = pool.request().input('productId', sql.Int, productId);
  let dealerTierId = null;
  if (dealerId) {
    const dealer = await pool.request().input('id', sql.Int, dealerId).query('SELECT TierId FROM dbo.Dealers WHERE DealerId = @id');
    dealerTierId = dealer.recordset[0] ? dealer.recordset[0].TierId : null;
  }
  request.input('tierId', sql.Int, dealerTierId);

  const result = await request.query(`
    SELECT TOP 1 i.ListPrice, i.MaxDiscountPct FROM dbo.PriceListItems i
    JOIN dbo.PriceLists pl ON pl.PriceListId = i.PriceListId
    WHERE i.ProductId = @productId AND pl.Status = 'ACTIVE'
      AND pl.EffectiveFrom <= CAST(SYSUTCDATETIME() AS DATE)
      AND (pl.EffectiveTo IS NULL OR pl.EffectiveTo >= CAST(SYSUTCDATETIME() AS DATE))
      AND (pl.DealerTierId = @tierId OR pl.DealerTierId IS NULL)
    ORDER BY CASE WHEN pl.DealerTierId IS NULL THEN 1 ELSE 0 END`);

  res.json(result.recordset[0] || null);
});

// --- Đơn hàng ---

router.get('/orders', async (req, res) => {
  const { status, dealerId, projectId } = req.query;
  const pool = await getPool();
  const request = pool.request();
  const conditions = [];
  if (status) { request.input('status', sql.NVarChar, status); conditions.push('o.Status = @status'); }
  if (dealerId) { request.input('dealerId', sql.Int, dealerId); conditions.push('o.DealerId = @dealerId'); }
  if (projectId) { request.input('projectId', sql.Int, projectId); conditions.push('o.ProjectId = @projectId'); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await request.query(`
    SELECT o.*, c.ChannelName, w.WarehouseName, d.DealerName, p.ProjectName
    FROM dbo.SalesOrders o
    LEFT JOIN dbo.SalesChannels c ON c.ChannelId = o.ChannelId
    JOIN dbo.Warehouses w ON w.WarehouseId = o.WarehouseId
    LEFT JOIN dbo.Dealers d ON d.DealerId = o.DealerId
    LEFT JOIN dbo.Projects p ON p.ProjectId = o.ProjectId
    ${where}
    ORDER BY o.CreatedAt DESC`);
  res.json(result.recordset);
});

router.get('/orders/:id', async (req, res) => {
  const pool = await getPool();
  const order = await pool.request().input('id', sql.BigInt, req.params.id).query(`
    SELECT o.*, c.ChannelName, w.WarehouseName, d.DealerName, p.ProjectName
    FROM dbo.SalesOrders o
    LEFT JOIN dbo.SalesChannels c ON c.ChannelId = o.ChannelId
    JOIN dbo.Warehouses w ON w.WarehouseId = o.WarehouseId
    LEFT JOIN dbo.Dealers d ON d.DealerId = o.DealerId
    LEFT JOIN dbo.Projects p ON p.ProjectId = o.ProjectId
    WHERE o.OrderId = @id`);
  if (!order.recordset[0]) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

  const items = await pool.request().input('id', sql.BigInt, req.params.id).query(`
    SELECT i.*, p.SKU, p.ProductName, p.UnitOfMeasure FROM dbo.SalesOrderItems i
    JOIN dbo.Products p ON p.ProductId = i.ProductId WHERE i.OrderId = @id`);

  res.json({ ...order.recordset[0], items: items.recordset });
});

router.post('/orders', requirePerm('salesOrderCreate'), async (req, res) => {
  const { orderType, channelId, customerType, dealerId, projectId, customerName, customerPhone, customerAddress, warehouseId, paymentTermDays } = req.body || {};
  if (!orderType || !customerType || !warehouseId) return res.status(400).json({ error: 'Thiếu loại đơn/loại khách hàng/kho' });
  if (customerType === 'DEALER' && !dealerId) return res.status(400).json({ error: 'Đơn hàng Đại lý cần chọn đại lý' });
  if (customerType === 'PROJECT' && !projectId) return res.status(400).json({ error: 'Đơn hàng Dự án cần chọn dự án' });

  // Retail (B2C) trả trước mặc định không qua thẩm định tín dụng (Mục 15.5).
  const requiresCreditCheck = orderType === 'B2C' ? false : true;

  const pool = await getPool();
  const result = await pool.request()
    .input('orderType', sql.NVarChar, orderType)
    .input('channelId', sql.Int, channelId || null)
    .input('customerType', sql.NVarChar, customerType)
    .input('dealerId', sql.Int, dealerId || null)
    .input('projectId', sql.Int, projectId || null)
    .input('customerName', sql.NVarChar, customerName || null)
    .input('customerPhone', sql.NVarChar, customerPhone || null)
    .input('customerAddress', sql.NVarChar, customerAddress || null)
    .input('warehouseId', sql.Int, warehouseId)
    .input('paymentTermDays', sql.Int, paymentTermDays || 0)
    .input('requiresCreditCheck', sql.Bit, requiresCreditCheck)
    .input('createdBy', sql.NVarChar, req.user.username)
    .query(`INSERT INTO dbo.SalesOrders (OrderCode, OrderType, ChannelId, CustomerType, DealerId, ProjectId,
              CustomerName, CustomerPhone, CustomerAddress, WarehouseId, PaymentTermDays, RequiresCreditCheck, CreatedBy)
            OUTPUT INSERTED.*
            VALUES (CONCAT('TMP-', CONVERT(NVARCHAR(36), NEWID())), @orderType, @channelId, @customerType, @dealerId, @projectId,
              @customerName, @customerPhone, @customerAddress, @warehouseId, @paymentTermDays, @requiresCreditCheck, @createdBy)`);

  const order = result.recordset[0];
  const orderCode = `DH${String(order.OrderId).padStart(6, '0')}`;
  await pool.request().input('id', sql.BigInt, order.OrderId).input('code', sql.NVarChar, orderCode)
    .query('UPDATE dbo.SalesOrders SET OrderCode = @code WHERE OrderId = @id');
  order.OrderCode = orderCode;

  await logAction(req, 'CREATE', 'SalesOrder', order.OrderId, req.body);
  res.status(201).json(order);
});

router.post('/orders/:id/items', requirePerm('salesOrderCreate'), async (req, res) => {
  const { productId, quantity, unitPrice, discountPct } = req.body || {};
  if (!productId || !quantity || unitPrice == null) return res.status(400).json({ error: 'Thiếu sản phẩm/số lượng/đơn giá' });

  const pool = await getPool();
  const order = await pool.request().input('id', sql.BigInt, req.params.id).query('SELECT Status FROM dbo.SalesOrders WHERE OrderId = @id');
  if (!order.recordset[0]) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  if (order.recordset[0].Status !== 'DRAFT') return res.status(400).json({ error: 'Chỉ thêm được sản phẩm khi đơn còn ở trạng thái NHÁP' });

  const result = await pool.request()
    .input('orderId', sql.BigInt, req.params.id)
    .input('productId', sql.Int, productId)
    .input('qty', sql.Decimal(18, 2), quantity)
    .input('price', sql.Decimal(18, 2), unitPrice)
    .input('discount', sql.Decimal(5, 2), discountPct || 0)
    .query(`INSERT INTO dbo.SalesOrderItems (OrderId, ProductId, Quantity, UnitPrice, DiscountPct)
            OUTPUT INSERTED.* VALUES (@orderId, @productId, @qty, @price, @discount)`);
  await logAction(req, 'CREATE', 'SalesOrderItem', result.recordset[0].OrderItemId, req.body);
  res.status(201).json(result.recordset[0]);
});

router.delete('/orders/:id/items/:itemId', requirePerm('salesOrderCreate'), async (req, res) => {
  const pool = await getPool();
  const order = await pool.request().input('id', sql.BigInt, req.params.id).query('SELECT Status FROM dbo.SalesOrders WHERE OrderId = @id');
  if (!order.recordset[0]) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  if (order.recordset[0].Status !== 'DRAFT') return res.status(400).json({ error: 'Chỉ xóa được sản phẩm khi đơn còn ở trạng thái NHÁP' });

  await pool.request().input('id', sql.BigInt, req.params.itemId).input('orderId', sql.BigInt, req.params.id)
    .query('DELETE FROM dbo.SalesOrderItems WHERE OrderItemId = @id AND OrderId = @orderId');
  await logAction(req, 'DELETE', 'SalesOrderItem', req.params.itemId, null);
  res.json({ ok: true });
});

router.post('/orders/:id/submit', requirePerm('salesOrderCreate'), async (req, res) => {
  const pool = await getPool();
  const order = await pool.request().input('id', sql.BigInt, req.params.id).query('SELECT ChannelId FROM dbo.SalesOrders WHERE OrderId = @id');
  if (!order.recordset[0]) return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });

  let hours = 72;
  if (order.recordset[0].ChannelId) {
    const channel = await pool.request().input('id', sql.Int, order.recordset[0].ChannelId)
      .query('SELECT DefaultReservationHours FROM dbo.SalesChannels WHERE ChannelId = @id');
    if (channel.recordset[0]) hours = channel.recordset[0].DefaultReservationHours;
  }

  try {
    await pool.request().input('OrderId', sql.BigInt, req.params.id).input('ReservationHours', sql.Decimal(6, 2), hours)
      .execute('dbo.SubmitSalesOrder');
    await logAction(req, 'SUBMIT', 'SalesOrder', req.params.id, { reservationHours: hours });
    res.json({ ok: true });
  } catch (err) {
    handleProcError(err, res);
  }
});

router.post('/orders/:id/cancel', requirePerm('salesOrderCreate'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().input('OrderId', sql.BigInt, req.params.id).input('Expired', sql.Bit, false).execute('dbo.CancelSalesOrder');
    await logAction(req, 'CANCEL', 'SalesOrder', req.params.id, null);
    res.json({ ok: true });
  } catch (err) {
    handleProcError(err, res);
  }
});

module.exports = router;
