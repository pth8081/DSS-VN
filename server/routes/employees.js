const express = require('express');
const bcrypt = require('bcryptjs');
const { sql, getPool } = require('../db');
const { requireAuth, requirePerm, logAction } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// --- Vị trí (Positions) — nền tảng cho nguyên tắc "Seat-based" ---

router.get('/positions', async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query('SELECT * FROM dbo.Positions ORDER BY DisplayOrder, PositionName');
  res.json(result.recordset);
});

router.post('/positions', requirePerm('employeeManage'), async (req, res) => {
  const { positionCode, positionName, department, displayOrder } = req.body || {};
  if (!positionCode || !positionName) return res.status(400).json({ error: 'Thiếu mã hoặc tên vị trí' });

  const pool = await getPool();
  try {
    const result = await pool.request()
      .input('code', sql.NVarChar, positionCode)
      .input('name', sql.NVarChar, positionName)
      .input('dept', sql.NVarChar, department || null)
      .input('order', sql.Int, displayOrder || 0)
      .query(`INSERT INTO dbo.Positions (PositionCode, PositionName, Department, DisplayOrder)
              OUTPUT INSERTED.* VALUES (@code, @name, @dept, @order)`);
    await logAction(req, 'CREATE', 'Position', result.recordset[0].PositionId, req.body);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627) return res.status(409).json({ error: 'Mã vị trí đã tồn tại' });
    throw err;
  }
});

router.put('/positions/:id', requirePerm('employeeManage'), async (req, res) => {
  const { positionName, department, displayOrder, isActive } = req.body || {};
  const pool = await getPool();
  await pool.request()
    .input('id', sql.Int, req.params.id)
    .input('name', sql.NVarChar, positionName)
    .input('dept', sql.NVarChar, department || null)
    .input('order', sql.Int, displayOrder || 0)
    .input('active', sql.Bit, isActive !== false)
    .query(`UPDATE dbo.Positions SET PositionName=@name, Department=@dept, DisplayOrder=@order, IsActive=@active
            WHERE PositionId=@id`);
  await logAction(req, 'UPDATE', 'Position', req.params.id, req.body);
  res.json({ ok: true });
});

// --- Nhân viên ---

router.get('/', async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT e.*, p.PositionName, p.Department AS PositionDepartment
    FROM dbo.Employees e LEFT JOIN dbo.Positions p ON p.PositionId = e.PositionId
    ORDER BY e.FullName`);
  res.json(result.recordset);
});

router.post('/', requirePerm('employeeManage'), async (req, res) => {
  const { employeeCode, fullName, email, phone, department, positionId } = req.body || {};
  if (!employeeCode || !fullName) return res.status(400).json({ error: 'Thiếu mã hoặc tên nhân viên' });

  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const request = new sql.Request(tx);
    const result = await request
      .input('code', sql.NVarChar, employeeCode)
      .input('name', sql.NVarChar, fullName)
      .input('email', sql.NVarChar, email || null)
      .input('phone', sql.NVarChar, phone || null)
      .input('dept', sql.NVarChar, department || null)
      .input('posId', sql.Int, positionId || null)
      .query(`INSERT INTO dbo.Employees (EmployeeCode, FullName, Email, Phone, Department, PositionId)
              OUTPUT INSERTED.* VALUES (@code, @name, @email, @phone, @dept, @posId)`);

    const employee = result.recordset[0];
    if (positionId) {
      await new sql.Request(tx)
        .input('empId', sql.Int, employee.EmployeeId)
        .input('posId', sql.Int, positionId)
        .query(`INSERT INTO dbo.EmployeePositionHistory (EmployeeId, PositionId, StartDate)
                VALUES (@empId, @posId, CAST(SYSUTCDATETIME() AS DATE))`);
    }
    await tx.commit();
    await logAction(req, 'CREATE', 'Employee', employee.EmployeeId, req.body);
    res.status(201).json(employee);
  } catch (err) {
    await tx.rollback();
    if (err.number === 2627) return res.status(409).json({ error: 'Mã nhân viên đã tồn tại' });
    throw err;
  }
});

router.put('/:id', requirePerm('employeeManage'), async (req, res) => {
  const { fullName, email, phone, department, positionId, isActive } = req.body || {};
  const pool = await getPool();

  const current = await pool.request().input('id', sql.Int, req.params.id)
    .query('SELECT PositionId FROM dbo.Employees WHERE EmployeeId = @id');
  if (!current.recordset[0]) return res.status(404).json({ error: 'Không tìm thấy nhân viên' });

  const positionChanged = positionId != null && positionId !== current.recordset[0].PositionId;

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx)
      .input('id', sql.Int, req.params.id)
      .input('name', sql.NVarChar, fullName)
      .input('email', sql.NVarChar, email || null)
      .input('phone', sql.NVarChar, phone || null)
      .input('dept', sql.NVarChar, department || null)
      .input('posId', sql.Int, positionId || null)
      .input('active', sql.Bit, isActive !== false)
      .query(`UPDATE dbo.Employees SET FullName=@name, Email=@email, Phone=@phone, Department=@dept,
              PositionId=@posId, IsActive=@active WHERE EmployeeId=@id`);

    if (positionChanged) {
      await new sql.Request(tx).input('id', sql.Int, req.params.id)
        .query(`UPDATE dbo.EmployeePositionHistory SET EndDate = CAST(SYSUTCDATETIME() AS DATE)
                WHERE EmployeeId=@id AND EndDate IS NULL`);
      await new sql.Request(tx)
        .input('empId', sql.Int, req.params.id)
        .input('posId', sql.Int, positionId)
        .query(`INSERT INTO dbo.EmployeePositionHistory (EmployeeId, PositionId, StartDate)
                VALUES (@empId, @posId, CAST(SYSUTCDATETIME() AS DATE))`);
    }
    await tx.commit();
    await logAction(req, 'UPDATE', 'Employee', req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    await tx.rollback();
    throw err;
  }
});

// --- Tài khoản người dùng (chỉ admin) ---

router.get('/users', requirePerm('employeeManage'), async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT u.UserId, u.Username, u.EmployeeId, u.IsAdmin, u.PermsJson, u.IsActive, u.LastLoginAt, e.FullName
    FROM dbo.Users u LEFT JOIN dbo.Employees e ON e.EmployeeId = u.EmployeeId
    ORDER BY u.Username`);
  res.json(result.recordset.map((u) => ({ ...u, PermsJson: undefined, perms: JSON.parse(u.PermsJson || '{}') })));
});

router.post('/users', requirePerm('employeeManage'), async (req, res) => {
  const { username, password, employeeId, isAdmin, perms } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Thiếu tên đăng nhập hoặc mật khẩu' });
  if (password.length < 6) return res.status(400).json({ error: 'Mật khẩu phải từ 6 ký tự trở lên' });

  const hash = await bcrypt.hash(password, 10);
  const pool = await getPool();
  try {
    const result = await pool.request()
      .input('username', sql.NVarChar, username)
      .input('hash', sql.NVarChar, hash)
      .input('empId', sql.Int, employeeId || null)
      .input('isAdmin', sql.Bit, !!isAdmin)
      .input('perms', sql.NVarChar(sql.MAX), JSON.stringify(perms || {}))
      .query(`INSERT INTO dbo.Users (Username, PasswordHash, EmployeeId, IsAdmin, PermsJson)
              OUTPUT INSERTED.UserId VALUES (@username, @hash, @empId, @isAdmin, @perms)`);
    await logAction(req, 'CREATE', 'User', result.recordset[0].UserId, { username, employeeId, isAdmin });
    res.status(201).json({ userId: result.recordset[0].UserId });
  } catch (err) {
    if (err.number === 2627) return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
    throw err;
  }
});

router.put('/users/:id', requirePerm('employeeManage'), async (req, res) => {
  const { isAdmin, perms, isActive, password } = req.body || {};
  const pool = await getPool();

  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Mật khẩu phải từ 6 ký tự trở lên' });
    const hash = await bcrypt.hash(password, 10);
    await pool.request().input('id', sql.Int, req.params.id).input('hash', sql.NVarChar, hash)
      .query('UPDATE dbo.Users SET PasswordHash=@hash WHERE UserId=@id');
  }

  await pool.request()
    .input('id', sql.Int, req.params.id)
    .input('isAdmin', sql.Bit, !!isAdmin)
    .input('perms', sql.NVarChar(sql.MAX), JSON.stringify(perms || {}))
    .input('active', sql.Bit, isActive !== false)
    .query('UPDATE dbo.Users SET IsAdmin=@isAdmin, PermsJson=@perms, IsActive=@active WHERE UserId=@id');

  await logAction(req, 'UPDATE', 'User', req.params.id, { isAdmin, perms, isActive, passwordChanged: !!password });
  res.json({ ok: true });
});

module.exports = router;
