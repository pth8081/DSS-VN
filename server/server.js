require('dotenv').config();
require('express-async-errors');

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const pkg = require('./package.json');

const authRoutes = require('./routes/auth');
const employeeRoutes = require('./routes/employees');
const catalogRoutes = require('./routes/catalog');
const inventoryRoutes = require('./routes/inventory');
const systemRoutes = require('./routes/system');
const dealerRoutes = require('./routes/dealers');
const projectRoutes = require('./routes/projects');
const salesRoutes = require('./routes/sales');
const { runExpirySweep } = require('./jobs/expireReservations');

const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: pkg.version, name: pkg.name });
});

app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/dealers', dealerRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/sales', salesRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Không tìm thấy endpoint' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.publicMessage || 'Lỗi hệ thống, vui lòng thử lại sau' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DSS-VN server (v${pkg.version}) đang chạy tại http://localhost:${PORT}`);
  setInterval(runExpirySweep, 60 * 60 * 1000);
  runExpirySweep();
});
