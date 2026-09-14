const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth, requirePerm, logAction } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function crudRoutes({ path, table, idColumn, columns, insertCols, updateCols, orderBy }) {
  router.get(`/${path}`, async (req, res) => {
    const pool = await getPool();
    const result = await pool.request().query(`SELECT * FROM dbo.${table} ORDER BY ${orderBy}`);
    res.json(result.recordset);
  });

  router.post(`/${path}`, requirePerm('catalogManage'), async (req, res) => {
    const body = req.body || {};
    const request = (await getPool()).request();
    insertCols.forEach((c) => request.input(c.name, c.type, body[c.name] ?? c.default ?? null));
    try {
      const result = await request.query(`
        INSERT INTO dbo.${table} (${insertCols.map((c) => c.column).join(', ')})
        OUTPUT INSERTED.*
        VALUES (${insertCols.map((c) => '@' + c.name).join(', ')})`);
      await logAction(req, 'CREATE', table, result.recordset[0][idColumn], body);
      res.status(201).json(result.recordset[0]);
    } catch (err) {
      if (err.number === 2627) return res.status(409).json({ error: 'Dữ liệu bị trùng (mã/tên duy nhất)' });
      throw err;
    }
  });

  router.put(`/${path}/:id`, requirePerm('catalogManage'), async (req, res) => {
    const body = req.body || {};
    const pool = await getPool();
    const request = pool.request().input('id', sql.Int, req.params.id);
    updateCols.forEach((c) => request.input(c.name, c.type, body[c.name] ?? c.default ?? null));
    await request.query(`
      UPDATE dbo.${table} SET ${updateCols.map((c) => `${c.column}=@${c.name}`).join(', ')}
      WHERE ${idColumn}=@id`);
    await logAction(req, 'UPDATE', table, req.params.id, body);
    res.json({ ok: true });
  });
}

// --- Nhóm sản phẩm ---
crudRoutes({
  path: 'categories', table: 'ProductCategories', idColumn: 'CategoryId', orderBy: 'CategoryName',
  insertCols: [
    { name: 'categoryName', column: 'CategoryName', type: sql.NVarChar },
    { name: 'defaultSerialTracking', column: 'DefaultSerialTracking', type: sql.Bit, default: false },
  ],
  updateCols: [
    { name: 'categoryName', column: 'CategoryName', type: sql.NVarChar },
    { name: 'defaultSerialTracking', column: 'DefaultSerialTracking', type: sql.Bit, default: false },
    { name: 'isActive', column: 'IsActive', type: sql.Bit, default: true },
  ],
});

// --- Sản phẩm ---
router.get('/products', async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT p.*, c.CategoryName, COALESCE(p.HasSerialTracking, c.DefaultSerialTracking) AS EffectiveSerialTracking
    FROM dbo.Products p LEFT JOIN dbo.ProductCategories c ON c.CategoryId = p.CategoryId
    ORDER BY p.ProductName`);
  res.json(result.recordset);
});

router.post('/products', requirePerm('catalogManage'), async (req, res) => {
  const { sku, productName, brand, categoryId, unitOfMeasure, hasSerialTracking } = req.body || {};
  if (!sku || !productName) return res.status(400).json({ error: 'Thiếu SKU hoặc tên sản phẩm' });

  const pool = await getPool();
  try {
    const result = await pool.request()
      .input('sku', sql.NVarChar, sku)
      .input('name', sql.NVarChar, productName)
      .input('brand', sql.NVarChar, brand || null)
      .input('categoryId', sql.Int, categoryId || null)
      .input('uom', sql.NVarChar, unitOfMeasure || 'Cái')
      .input('serial', sql.Bit, hasSerialTracking === null || hasSerialTracking === undefined ? null : !!hasSerialTracking)
      .query(`INSERT INTO dbo.Products (SKU, ProductName, Brand, CategoryId, UnitOfMeasure, HasSerialTracking)
              OUTPUT INSERTED.* VALUES (@sku, @name, @brand, @categoryId, @uom, @serial)`);
    await logAction(req, 'CREATE', 'Product', result.recordset[0].ProductId, req.body);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627) return res.status(409).json({ error: 'SKU đã tồn tại' });
    throw err;
  }
});

router.put('/products/:id', requirePerm('catalogManage'), async (req, res) => {
  const { productName, brand, categoryId, unitOfMeasure, hasSerialTracking, isActive } = req.body || {};
  const pool = await getPool();
  await pool.request()
    .input('id', sql.Int, req.params.id)
    .input('name', sql.NVarChar, productName)
    .input('brand', sql.NVarChar, brand || null)
    .input('categoryId', sql.Int, categoryId || null)
    .input('uom', sql.NVarChar, unitOfMeasure || 'Cái')
    .input('serial', sql.Bit, hasSerialTracking === null || hasSerialTracking === undefined ? null : !!hasSerialTracking)
    .input('active', sql.Bit, isActive !== false)
    .query(`UPDATE dbo.Products SET ProductName=@name, Brand=@brand, CategoryId=@categoryId,
            UnitOfMeasure=@uom, HasSerialTracking=@serial, IsActive=@active WHERE ProductId=@id`);
  await logAction(req, 'UPDATE', 'Product', req.params.id, req.body);
  res.json({ ok: true });
});

// --- Kho ---
crudRoutes({
  path: 'warehouses', table: 'Warehouses', idColumn: 'WarehouseId', orderBy: 'WarehouseName',
  insertCols: [
    { name: 'warehouseCode', column: 'WarehouseCode', type: sql.NVarChar },
    { name: 'warehouseName', column: 'WarehouseName', type: sql.NVarChar },
    { name: 'address', column: 'Address', type: sql.NVarChar },
  ],
  updateCols: [
    { name: 'warehouseName', column: 'WarehouseName', type: sql.NVarChar },
    { name: 'address', column: 'Address', type: sql.NVarChar },
    { name: 'isActive', column: 'IsActive', type: sql.Bit, default: true },
  ],
});

// --- Khu vực ---
crudRoutes({
  path: 'regions', table: 'Regions', idColumn: 'RegionId', orderBy: 'DisplayOrder, RegionName',
  insertCols: [
    { name: 'regionCode', column: 'RegionCode', type: sql.NVarChar },
    { name: 'regionName', column: 'RegionName', type: sql.NVarChar },
    { name: 'displayOrder', column: 'DisplayOrder', type: sql.Int, default: 0 },
  ],
  updateCols: [
    { name: 'regionName', column: 'RegionName', type: sql.NVarChar },
    { name: 'displayOrder', column: 'DisplayOrder', type: sql.Int, default: 0 },
    { name: 'isActive', column: 'IsActive', type: sql.Bit, default: true },
  ],
});

// --- Hạng đại lý ---
crudRoutes({
  path: 'dealer-tiers', table: 'DealerTiers', idColumn: 'TierId', orderBy: 'DisplayOrder, TierName',
  insertCols: [
    { name: 'tierName', column: 'TierName', type: sql.NVarChar },
    { name: 'defaultCreditLimit', column: 'DefaultCreditLimit', type: sql.Decimal(18, 2), default: 0 },
    { name: 'defaultPaymentTermDays', column: 'DefaultPaymentTermDays', type: sql.Int, default: 0 },
    { name: 'defaultMaxDiscountPct', column: 'DefaultMaxDiscountPct', type: sql.Decimal(5, 2), default: 0 },
    { name: 'displayOrder', column: 'DisplayOrder', type: sql.Int, default: 0 },
  ],
  updateCols: [
    { name: 'tierName', column: 'TierName', type: sql.NVarChar },
    { name: 'defaultCreditLimit', column: 'DefaultCreditLimit', type: sql.Decimal(18, 2), default: 0 },
    { name: 'defaultPaymentTermDays', column: 'DefaultPaymentTermDays', type: sql.Int, default: 0 },
    { name: 'defaultMaxDiscountPct', column: 'DefaultMaxDiscountPct', type: sql.Decimal(5, 2), default: 0 },
    { name: 'displayOrder', column: 'DisplayOrder', type: sql.Int, default: 0 },
    { name: 'isActive', column: 'IsActive', type: sql.Bit, default: true },
  ],
});

// --- Bảng giá ---
router.get('/price-lists', async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT pl.*, t.TierName FROM dbo.PriceLists pl LEFT JOIN dbo.DealerTiers t ON t.TierId = pl.DealerTierId
    ORDER BY pl.EffectiveFrom DESC`);
  res.json(result.recordset);
});

router.post('/price-lists', requirePerm('catalogManage'), async (req, res) => {
  const { priceListName, dealerTierId, effectiveFrom, effectiveTo } = req.body || {};
  if (!priceListName || !effectiveFrom) return res.status(400).json({ error: 'Thiếu tên bảng giá hoặc ngày hiệu lực' });

  const pool = await getPool();
  const result = await pool.request()
    .input('name', sql.NVarChar, priceListName)
    .input('tierId', sql.Int, dealerTierId || null)
    .input('from', sql.Date, effectiveFrom)
    .input('to', sql.Date, effectiveTo || null)
    .query(`INSERT INTO dbo.PriceLists (PriceListName, DealerTierId, EffectiveFrom, EffectiveTo)
            OUTPUT INSERTED.* VALUES (@name, @tierId, @from, @to)`);
  await logAction(req, 'CREATE', 'PriceList', result.recordset[0].PriceListId, req.body);
  res.status(201).json(result.recordset[0]);
});

router.get('/price-lists/:id/items', async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().input('id', sql.Int, req.params.id).query(`
    SELECT i.*, p.SKU, p.ProductName FROM dbo.PriceListItems i
    JOIN dbo.Products p ON p.ProductId = i.ProductId WHERE i.PriceListId = @id ORDER BY p.ProductName`);
  res.json(result.recordset);
});

router.post('/price-lists/:id/items', requirePerm('catalogManage'), async (req, res) => {
  const { productId, listPrice, maxDiscountPct } = req.body || {};
  if (!productId || listPrice == null) return res.status(400).json({ error: 'Thiếu sản phẩm hoặc giá niêm yết' });

  const pool = await getPool();
  try {
    const result = await pool.request()
      .input('priceListId', sql.Int, req.params.id)
      .input('productId', sql.Int, productId)
      .input('price', sql.Decimal(18, 2), listPrice)
      .input('maxDiscount', sql.Decimal(5, 2), maxDiscountPct || 0)
      .query(`INSERT INTO dbo.PriceListItems (PriceListId, ProductId, ListPrice, MaxDiscountPct)
              OUTPUT INSERTED.* VALUES (@priceListId, @productId, @price, @maxDiscount)`);
    await logAction(req, 'CREATE', 'PriceListItem', result.recordset[0].PriceListItemId, req.body);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627) return res.status(409).json({ error: 'Sản phẩm đã có trong bảng giá này' });
    throw err;
  }
});

module.exports = router;
