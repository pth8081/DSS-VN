const jwt = require('jsonwebtoken');
const { sql, getPool } = require('../db');

const COOKIE_NAME = 'dssvn_token';

function issueToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '8h' });
}

// Zero Trust (nguyên tắc 2): không tin dữ liệu quyền trong JWT, luôn tải lại
// user + PermsJson mới nhất từ DB ở mỗi request thay vì nhúng quyền vào token.
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const pool = await getPool();
    const result = await pool.request()
      .input('userId', sql.Int, payload.userId)
      .query('SELECT UserId, Username, EmployeeId, IsAdmin, PermsJson, IsActive FROM dbo.Users WHERE UserId = @userId');

    const user = result.recordset[0];
    if (!user || !user.IsActive) return res.status(401).json({ error: 'Tài khoản không hợp lệ hoặc đã bị khóa' });

    let perms = {};
    try { perms = JSON.parse(user.PermsJson || '{}'); } catch { perms = {}; }

    req.user = {
      userId: user.UserId,
      username: user.Username,
      employeeId: user.EmployeeId,
      isAdmin: !!user.IsAdmin,
      perms,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn' });
  }
}

function requirePerm(permKey) {
  return (req, res, next) => {
    if (req.user && (req.user.isAdmin || req.user.perms[permKey] === true)) return next();
    return res.status(403).json({ error: 'Không có quyền thực hiện thao tác này' });
  };
}

async function logAction(req, action, entityType, entityId, detail) {
  try {
    const pool = await getPool();
    await pool.request()
      .input('userId', sql.Int, req.user ? req.user.userId : null)
      .input('username', sql.NVarChar, req.user ? req.user.username : null)
      .input('action', sql.NVarChar, action)
      .input('entityType', sql.NVarChar, entityType || null)
      .input('entityId', sql.NVarChar, entityId != null ? String(entityId) : null)
      .input('detailJson', sql.NVarChar(sql.MAX), detail ? JSON.stringify(detail) : null)
      .input('ip', sql.NVarChar, req.ip || null)
      .query(`INSERT INTO dbo.SystemLog (UserId, Username, Action, EntityType, EntityId, DetailJson, IPAddress)
              VALUES (@userId, @username, @action, @entityType, @entityId, @detailJson, @ip)`);
  } catch (err) {
    console.error('Ghi SystemLog thất bại:', err.message);
  }
}

module.exports = { COOKIE_NAME, issueToken, requireAuth, requirePerm, logAction };
