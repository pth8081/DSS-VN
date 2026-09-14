const express = require('express');
const { sql, getPool } = require('../db');
const { requireAuth, requirePerm, logAction } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/logs', requirePerm('systemLogView'), async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query('SELECT TOP 300 * FROM dbo.SystemLog ORDER BY CreatedAt DESC');
  res.json(result.recordset);
});

router.get('/config', requirePerm('employeeManage'), async (req, res) => {
  const pool = await getPool();
  const result = await pool.request().query('SELECT * FROM dbo.AppConfig ORDER BY ConfigKey');
  res.json(result.recordset);
});

router.put('/config/:key', requirePerm('employeeManage'), async (req, res) => {
  const { value } = req.body || {};
  const pool = await getPool();
  await pool.request()
    .input('key', sql.NVarChar, req.params.key)
    .input('value', sql.NVarChar(sql.MAX), value != null ? String(value) : null)
    .query(`MERGE dbo.AppConfig AS target
            USING (SELECT @key AS ConfigKey) AS src ON target.ConfigKey = src.ConfigKey
            WHEN MATCHED THEN UPDATE SET ConfigValue = @value, UpdatedAt = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN INSERT (ConfigKey, ConfigValue) VALUES (@key, @value);`);
  await logAction(req, 'UPDATE', 'AppConfig', req.params.key, { value });
  res.json({ ok: true });
});

module.exports = router;
