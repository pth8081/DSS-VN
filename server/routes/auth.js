const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { sql, getPool } = require('../db');
const { COOKIE_NAME, issueToken, requireAuth, logAction } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Đăng nhập sai quá nhiều lần, vui lòng thử lại sau' },
});

function sanitizeUser(user) {
  let perms = {};
  try { perms = JSON.parse(user.PermsJson || '{}'); } catch { perms = {}; }
  return {
    userId: user.UserId,
    username: user.Username,
    employeeId: user.EmployeeId,
    isAdmin: !!user.IsAdmin,
    perms,
  };
}

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Thiếu tên đăng nhập hoặc mật khẩu' });

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('username', sql.NVarChar, username)
      .query('SELECT UserId, Username, EmployeeId, PasswordHash, IsAdmin, PermsJson, IsActive FROM dbo.Users WHERE Username = @username');

    const user = result.recordset[0];
    if (!user || !user.IsActive) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });

    const match = await bcrypt.compare(password, user.PasswordHash);
    if (!match) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });

    await pool.request().input('userId', sql.Int, user.UserId)
      .query('UPDATE dbo.Users SET LastLoginAt = SYSUTCDATETIME() WHERE UserId = @userId');

    const token = issueToken(user.UserId);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000,
    });

    req.user = sanitizeUser(user);
    await logAction(req, 'LOGIN', 'User', user.UserId, null);

    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    console.error('Lỗi đăng nhập:', err.message);
    res.status(500).json({ error: 'Lỗi hệ thống, vui lòng thử lại sau' });
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  await logAction(req, 'LOGOUT', 'User', req.user.userId, null);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
