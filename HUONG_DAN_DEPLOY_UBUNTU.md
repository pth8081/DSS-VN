# HƯỚNG DẪN TRIỂN KHAI DSS-VN (PHÂN PHỐI CNTT) TRÊN UBUNTU SERVER
### Node.js + SQL Server (MSSQL)

> Tài liệu này mô tả đúng những gì đã có trong code ở **Giai đoạn 1** (Danh
> mục nền tảng + Kho hàng + Hệ thống cơ bản). Các giai đoạn sau (Đại lý, Dự
> án, Bán hàng đa kênh, Phê duyệt, Công nợ, Hợp đồng, CRM, Báo cáo — xem
> `thiet_ke_he_thong_phan_phoi_cntt.md`) sẽ bổ sung thêm mục ở tài liệu này
> khi triển khai, không tạo file hướng dẫn riêng.

---

## 0. Tổng quan kiến trúc

```
[Trình duyệt người dùng]
        │  HTTP(S) (qua Nginx cổng 80/443, cookie phiên đăng nhập httpOnly)
        ▼
[Ubuntu Server]
   ├─ Nginx — reverse proxy cổng 80/443 → 127.0.0.1:3000 (mục 9)
   ├─ Node.js (Express, chạy dưới PM2) — port 3000 — phục vụ giao diện + API,
   │  xác thực bằng JWT ký ở server, cookie httpOnly (xem mục 6)
   └─ SQL Server (MSSQL) — port 1433 — lưu trữ dữ liệu, mỗi nghiệp vụ 1 bảng
      riêng (không dồn chung 1 blob JSON) — xem `server/sql/schema.sql`
```

**Đặc điểm kiến trúc cần biết trước khi triển khai:**

- **Xác thực hoàn toàn ở phía SERVER.** Mật khẩu lưu dạng hash (bcrypt).
  Đăng nhập cấp 1 phiên qua cookie JWT httpOnly, ký bằng `JWT_SECRET` — biến
  này **bắt buộc phải có trong `.env`, server sẽ không khởi động nếu thiếu**
  (xem mục 6). Mọi API nghiệp vụ đều tải lại quyền (`PermsJson`) mới nhất từ
  DB ở mỗi request thay vì tin dữ liệu quyền nhúng sẵn trong JWT (nguyên tắc
  Zero Trust — xem tài liệu thiết kế Mục 0.2).
- **Mọi thao tác thay đổi tồn kho đi qua stored procedure** (`ImportStock`,
  `AdjustStock`, `TransferStock`, `ReserveStock`, `ReleaseStock` trong
  `sql/schema.sql`), dùng `UPDLOCK`/`ROWLOCK` để 2 giao dịch cùng lúc không
  thể cùng vượt quá tồn kho khả dụng thật.
- **`server/uploads/`, cấu hình SMTP/email, CAPTCHA, WebAuthn, PWA, cluster
  mode** đều **CHƯA có ở Giai đoạn 1** — sẽ bổ sung khi module tương ứng cần
  đến (ví dụ upload chứng từ ở Module Hợp đồng & Thanh toán). Đừng tìm các
  biến `.env`/file liên quan tới các mục này ở bản hiện tại.

---

## 1. Cài đặt Node.js trên Ubuntu

```bash
# Cài Node.js 20 LTS (khuyến nghị) qua NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Kiểm tra
node -v      # >= v18
npm -v
```

---

## 2. Cài đặt SQL Server (MSSQL) trên Ubuntu

Có 3 lựa chọn — chọn 1:

### Lựa chọn A: Cài SQL Server trực tiếp trên Ubuntu (khuyến nghị cho server riêng)

```bash
# Thêm repo Microsoft SQL Server 2022 cho Ubuntu 22.04 (đổi "22.04" nếu bạn dùng bản khác)
sudo curl -o /etc/apt/trusted.gpg.d/microsoft.asc https://packages.microsoft.com/keys/microsoft.asc
sudo curl -o /etc/apt/sources.list.d/mssql-server-2022.list https://packages.microsoft.com/config/ubuntu/22.04/mssql-server-2022.list

sudo apt-get update
sudo apt-get install -y mssql-server

# Chạy cấu hình lần đầu: chọn Edition (Developer/Express miễn phí cho test, hoặc nhập license Standard/Enterprise) và đặt mật khẩu SA
sudo /opt/mssql/bin/mssql-conf setup

# Kiểm tra dịch vụ
systemctl status mssql-server --no-pager
```

Cài thêm công cụ dòng lệnh `sqlcmd` để chạy script SQL:

```bash
sudo curl -o /etc/apt/trusted.gpg.d/microsoft.asc https://packages.microsoft.com/keys/microsoft.asc
sudo curl -o /etc/apt/sources.list.d/mssql-tools.list https://packages.microsoft.com/config/ubuntu/22.04/prod.list
sudo apt-get update
sudo ACCEPT_EULA=Y apt-get install -y mssql-tools18 unixodbc-dev

echo 'export PATH="$PATH:/opt/mssql-tools18/bin"' >> ~/.bashrc
source ~/.bashrc
```

### Lựa chọn B: Chạy SQL Server bằng Docker (nhanh, gọn, dễ backup/di chuyển)

```bash
sudo apt-get install -y docker.io
sudo docker run -e "ACCEPT_EULA=Y" -e "MSSQL_SA_PASSWORD=Your_Strong_Password_Here" \
  -p 1433:1433 --name dssvn-mssql --restart unless-stopped \
  -v dssvn-mssql-data:/var/opt/mssql \
  -d mcr.microsoft.com/mssql/server:2022-latest
```

### Lựa chọn C: Dùng SQL Server có sẵn trên máy chủ Windows khác trong công ty

Nếu công ty đã có máy chủ SQL Server riêng, bạn **không cần cài SQL Server
trên Ubuntu** — chỉ cần đảm bảo Ubuntu server có thể kết nối tới máy chủ SQL
Server đó qua mạng nội bộ (port 1433 mở trên firewall Windows), rồi trỏ file
`.env` (mục 6) tới địa chỉ IP của máy chủ đó.

---

## 3. Chuẩn bị thư mục ứng dụng trên Ubuntu

**Làm bước này TRƯỚC khi tạo database ở mục 4** — script SQL nằm sẵn trong
mã nguồn (`sql/schema.sql`), phải có mã nguồn trên máy trước mới chạy được.

```bash
sudo mkdir -p /opt/dss-vn
sudo chown $USER:$USER /opt/dss-vn
cd /opt/dss-vn
# Copy TOÀN BỘ nội dung thư mục server/ đã cung cấp vào đây (scp/rsync/git clone từ máy local)

npm install
```

`npm install` đọc `package.json` và cài đủ mọi gói ứng dụng cần (Express,
mssql, bcryptjs, jsonwebtoken...) — bỏ sót bước này ở lần dựng đầu tiên khiến
server báo lỗi `Cannot find module '...'` và thoát ngay lúc khởi động (xem
cảnh báo tương tự ở mục 12 cho các lần cập nhật code sau này).

---

## 4. Tạo Database và bảng dữ liệu

Từ trong thư mục `/opt/dss-vn` (đã có `sql/schema.sql` từ mục 3):

```bash
cd /opt/dss-vn/sql
sqlcmd -S localhost -U sa -P 'Your_Strong_Password_Here' -i schema.sql
```

Nếu dùng Docker (Lựa chọn B ở mục 2), chạy `sqlcmd` từ máy host trỏ
`-S localhost,1433`, hoặc `docker exec` vào container rồi chạy từ trong đó.
Nếu dùng SQL Server có sẵn ở máy khác (Lựa chọn C), đổi `-S localhost` thành
đúng IP máy chủ đó.

Script này **an toàn để chạy lại nhiều lần** (chỉ tạo bảng/proc nào chưa có,
không đụng dữ liệu cũ) — sẽ:
- Tạo database `DSS_VN`
- Tạo toàn bộ bảng danh mục (Sản phẩm, Nhóm sản phẩm, Kho, Bảng giá, Hạng đại
  lý, Khu vực), bảng kho hàng (`InventoryBalances`, `InventoryTransactions`)
  và các stored procedure thao tác kho, cùng bảng hệ thống (Vị trí, Nhân
  viên, Tài khoản, Nhật ký, Cấu hình)
- Seed dữ liệu mặc định: 1 tài khoản `admin`, 4 hạng đại lý, 7 nhóm sản phẩm
  mẫu, 1 kho chính (chi tiết xem cuối `sql/schema.sql`)

---

## 5. Kiểm tra kết nối SQL Server trước khi cấu hình ứng dụng

```bash
sqlcmd -S localhost -U sa -P 'Your_Strong_Password_Here' -Q "SELECT name FROM sys.databases;"
```

Phải thấy `DSS_VN` trong danh sách trả về. Nếu lỗi kết nối ở bước này, xử
lý dứt điểm trước khi sang mục 6 — mọi lỗi kết nối DB sau này (mục 8, mục 9)
đều bắt nguồn từ đây.

---

## 6. Cấu hình kết nối SQL Server + xác thực đăng nhập

```bash
cd /opt/dss-vn
cp .env.example .env
nano .env
```

Điền đúng thông tin — các biến dưới đây đều **bắt buộc** để server khởi
động được (server kiểm tra và thoát ngay nếu thiếu bất kỳ biến nào):

```
DB_SERVER=localhost          # hoặc IP máy chủ SQL Server nếu chạy riêng (Lựa chọn C ở mục 2)
DB_PORT=1433
DB_NAME=DSS_VN
DB_USER=sa
DB_PASSWORD=Your_Strong_Password_Here
JWT_SECRET=change-me-to-a-long-random-string
```

Tạo `JWT_SECRET` bằng lệnh:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Đây là khoá ký phiên đăng nhập (JWT) — **PHẢI là chuỗi ngẫu nhiên dài, giữ
kín, và khác nhau giữa các môi trường** (dev/staging/production). Đổi giá trị
này sẽ khiến mọi phiên đăng nhập đang mở bị đăng xuất (không sao, chỉ cần
đăng nhập lại) — hữu ích nếu nghi ngờ khoá đã lộ.

Các biến còn lại trong `.env.example` (`PORT`, `DB_ENCRYPT`,
`DB_TRUST_SERVER_CERTIFICATE`, `UPLOAD_MAX_MB`) là tuỳ chọn, có giá trị mặc
định hợp lý sẵn trong code — chỉ cần điền khi bạn thực sự cần đổi khác mặc
định.

> ⚠️ Không commit file `.env` lên Git — chứa mật khẩu SQL Server và khoá
> `JWT_SECRET`. File `.gitignore` trong `server/` đã loại trừ sẵn `.env`.

> ⚠️ Cookie phiên đăng nhập chỉ đặt cờ `Secure` khi chạy với `NODE_ENV=production`
> (xem `server/routes/auth.js`) — bắt buộc chạy qua HTTPS thật (mục 9) trước
> khi đưa vào dùng thật với `NODE_ENV=production`, nếu không trình duyệt sẽ
> không lưu lại cookie qua `http://` thường và người dùng không đăng nhập
> giữ được phiên.

---

## 7. Chạy thử (kiểm tra trước khi đưa vào production)

```bash
cd /opt/dss-vn
npm start
```

Kỳ vọng thấy log:
```
Đã kết nối SQL Server: localhost / DSS_VN
DSS-VN server (v1.0) đang chạy tại http://localhost:3000
```

Dòng "Đã kết nối SQL Server" chỉ in ra khi có request đầu tiên chạm tới DB
(kết nối lười — lazy pool), không phải ngay lúc khởi động; mở trình duyệt và
đăng nhập thử là đủ để kích hoạt.

Mở trình duyệt: `http://<ip-server>:3000` — đăng nhập thử với tài khoản mặc định:
- `admin / 123456`

**Đổi mật khẩu tài khoản `admin` ngay sau khi xác nhận đăng nhập được** (tạo
tài khoản admin thật của công ty ở tab "Tài khoản & Phân quyền", khoá/đổi mật
khẩu tài khoản `admin` mặc định) — Giai đoạn 1 **chưa có** màn hình tự đổi
mật khẩu cho chính mình, đổi qua API `PUT /api/employees/users/:id` (trường
`password`) hoặc trực tiếp trong SQL nếu cần.

Dừng lại (Ctrl+C) sau khi xác nhận chạy được — bước này chỉ để kiểm tra
trước khi chuyển sang chạy nền bằng PM2 (mục 8).

---

## 8. Chạy production ổn định bằng PM2

```bash
sudo npm install -g pm2

cd /opt/dss-vn
NODE_ENV=production pm2 start server.js --name dss-vn

# Tự khởi động lại khi server reboot
pm2 startup systemd
pm2 save
```

`NODE_ENV=production` cần thiết để cookie phiên đăng nhập đặt cờ `Secure`
đúng (mục 6) — **không bỏ qua bước này khi deploy lên máy chủ thật**.

Các lệnh quản lý thường dùng:
```bash
pm2 status                # xem trạng thái tiến trình
pm2 logs dss-vn           # xem log realtime
pm2 restart dss-vn        # khởi động lại sau khi cập nhật code
pm2 stop dss-vn
```

Giai đoạn 1 chạy 1 tiến trình đơn (fork mode) là đủ cho quy mô nội bộ ban
đầu. Khi số người dùng đồng thời tăng lên, cân nhắc PM2 cluster mode
(`instances: 'max'` qua `ecosystem.config.js`) — sẽ bổ sung hướng dẫn cụ thể
kèm số liệu đo tải thật khi triển khai tới quy mô đó, tránh cấu hình sớm mà
không có số liệu.

---

## 9. Nginx (reverse proxy cổng 80/443 → 3000) + HTTPS

```bash
sudo apt-get install -y nginx
sudo nano /etc/nginx/sites-available/dss-vn
```

Nội dung:

```nginx
server {
    listen 80;
    server_name dss-vn.congty.local;   # đổi thành domain/IP nội bộ của bạn

    client_max_body_size 20M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/dss-vn /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Mở firewall (nếu dùng `ufw`) — sau lệnh `enable`, chỉ còn 80/443/22 mở ra
ngoài, cổng 3000 (Node) và 1433 (SQL Server) tự động bị chặn từ bên ngoài:
```bash
sudo ufw allow 'Nginx Full'
sudo ufw allow OpenSSH
sudo ufw enable
```

**Bật HTTPS** bằng 1 trong 2 cách trước khi đưa vào dùng thật (bắt buộc để
cookie phiên đăng nhập hoạt động khi chạy `NODE_ENV=production` — xem mục 6):
- Có domain public trỏ về server: dùng `certbot` (Let's Encrypt, miễn phí).
- Chỉ dùng nội bộ (LAN/VPN, không có domain public): tự cấp chứng chỉ qua CA
  nội bộ của công ty, hoặc dùng chứng chỉ self-signed cho môi trường thử
  nghiệm (trình duyệt sẽ cảnh báo "không an toàn", chấp nhận thủ công 1 lần).

---

## 10. Cài đặt fail2ban (khuyến nghị khi mở ra Internet công khai)

Ứng dụng đã tự giới hạn tần suất đăng nhập theo IP (`express-rate-limit` ở
`server/routes/auth.js`), nhưng mỗi lượt vẫn phải đi hết qua Nginx + Node
trước khi bị từ chối. fail2ban thêm 1 lớp CHẶN Ở FIREWALL — đọc log truy cập
Nginx, phát hiện 1 địa chỉ IP có hành vi bất thường lặp lại thì cấm hẳn IP đó
kết nối tới server trong 1 khoảng thời gian.

```bash
sudo apt-get install -y fail2ban
```

Repo đã có sẵn 2 bộ lọc + cấu hình jail mẫu tại `deploy/fail2ban/` — chỉ cần
copy sang đúng thư mục fail2ban đọc:

```bash
sudo cp deploy/fail2ban/filter.d/dssvn-login.conf     /etc/fail2ban/filter.d/
sudo cp deploy/fail2ban/filter.d/dssvn-ratelimit.conf /etc/fail2ban/filter.d/
sudo cp deploy/fail2ban/jail.d/dssvn.conf             /etc/fail2ban/jail.d/
sudo systemctl restart fail2ban
```

Kiểm tra đã chạy đúng:
```bash
sudo fail2ban-client status dssvn-login
sudo fail2ban-client status dssvn-ratelimit
```

Ngưỡng mặc định trong `deploy/fail2ban/jail.d/dssvn.conf` (10 lần đăng nhập
sai hoặc 15 lần bị 429 trong 10 phút thì cấm 1 giờ) là điểm khởi đầu hợp lý
— chỉnh trực tiếp file này (`maxretry`/`findtime`/`bantime`) theo thực tế
lưu lượng của công ty bạn nếu cần, không cần sửa gì ở code ứng dụng.

> Lưu ý: nếu server của bạn còn đứng sau 1 lớp proxy/CDN khác nữa (ví dụ
> Cloudflare) TRƯỚC Nginx, `$remote_addr` trong log Nginx sẽ là IP của lớp
> đó chứ không phải IP người dùng thật — cần cấu hình Nginx `real_ip_header`
> tương ứng trước khi fail2ban chặn đúng IP.

---

## 11. Tình trạng bảo mật hiện tại và việc cần làm trước khi public

### 11.1. Đã có ở Giai đoạn 1

- Xác thực phía server (bcrypt + JWT cookie httpOnly), quyền tải lại từ DB ở
  mỗi request (Zero Trust).
- Giới hạn tần suất đăng nhập theo IP (`express-rate-limit`, 20 lần/15 phút).
- Ràng buộc tồn kho ở tầng CSDL (`UPDLOCK`/`ROWLOCK` trong các stored
  procedure kho hàng) — 2 giao dịch đồng thời không thể cùng vượt tồn kho
  khả dụng thật.
- Nhật ký hệ thống (`dbo.SystemLog`) ghi mọi thao tác tạo/sửa nhạy cảm.

### 11.2. Chưa có — cân nhắc bổ sung trước khi public rộng ra Internet

- Khoá tài khoản theo số lần đăng nhập sai liên tiếp (hiện chỉ giới hạn theo
  IP, chưa khoá riêng theo từng tài khoản).
- Buộc đổi mật khẩu mặc định ở lần đăng nhập đầu, chính sách độ mạnh mật
  khẩu.
- `TRUST_PROXY`/xử lý `X-Forwarded-For` khi đứng sau Nginx — nếu triển khai
  rate-limit theo IP thật ở tầng ứng dụng cho các API khác ngoài đăng nhập,
  cần bật tương ứng trong Express (`app.set('trust proxy', 1)`).
- HTTP security headers (CSP, HSTS, X-Frame-Options...).
- CAPTCHA ở trang đăng nhập.

Việc cần tự làm khi triển khai:
1. Đặt `JWT_SECRET` là chuỗi ngẫu nhiên dài, khác nhau giữa các môi trường.
2. Chạy `NODE_ENV=production` + HTTPS thật trước khi cho người dùng thật
   đăng nhập (mục 6, mục 9).
3. Chỉ mở port 3000/1433 trong mạng nội bộ (LAN/VPN công ty); không expose
   thẳng ra Internet.
4. Đổi mật khẩu tài khoản `admin` mặc định ngay sau khi triển khai (mục 7).
5. Backup định kỳ database:
   ```bash
   sqlcmd -S localhost -U sa -Q "BACKUP DATABASE DSS_VN TO DISK = '/var/backups/dssvn_$(date +%F).bak'"
   ```
   Đặt thành cron job chạy hàng ngày.

---

## 12. Kiểm tra sức khỏe hệ thống

Endpoint kiểm tra nhanh:
```
GET http://<ip-server>:3000/api/health
→ {"ok":true,"version":"1.0","name":"dss-vn-server"}
```

`version` khớp đúng trường `version` trong `package.json` của bản code server
đang chạy — dùng để xác nhận sau khi cập nhật code (mục 13) đã áp dụng đúng
bản mới hay chưa.

Dùng cho giám sát (uptime monitor, script cron cảnh báo qua email/Zalo nếu server down).

---

## 13. Cập nhật code sau này

**Chỉ copy code + `pm2 restart` là đủ CHỈ KHI** bản cập nhật không đổi gì
ngoài code. Với bản cập nhật lớn hơn, cần kiểm tra thêm 3 chỗ sau trước khi
restart:

1. **`server/sql/schema.sql` đổi** — bảng/cột/index/proc mới, hoặc sửa lỗi
   trong chính script này. An toàn chạy lại nhiều lần (mọi thay đổi đều bọc
   trong `IF OBJECT_ID(...) IS NULL`), nhưng **PHẢI chạy lại** nếu file này
   có thay đổi so với bản đang chạy.
2. **`server/.env.example` đổi** — biến môi trường mới hoặc đổi ý nghĩa. So
   sánh với `.env` hiện tại (`diff .env .env.example`) để biết biến nào cần
   thêm — báo cáo cập nhật sẽ luôn nêu rõ biến nào **bắt buộc**, biến nào chỉ
   cần khi dùng đúng tính năng liên quan.
3. **`server/package.json` đổi `dependencies`** — cần chạy lại `npm install`
   trong thư mục `server/` trước khi restart, nếu không server sẽ báo lỗi
   "Cannot find module" ngay khi khởi động.

**Quy trình cập nhật đầy đủ, an toàn cho mọi trường hợp:**

```bash
# 0. Backup CSDL trước (luôn làm, kể cả khi tưởng chỉ đổi code)
sqlcmd -S localhost -U sa -Q "BACKUP DATABASE DSS_VN TO DISK = '/var/backups/dssvn_$(date +%F).bak'"

cd /opt/dss-vn
# 1. Lấy code mới (git pull hoặc copy đè)

# 2. Cài lại dependency (vô hại nếu không có gói mới)
npm install

# 3. Chạy lại schema.sql — an toàn chạy nhiều lần
sqlcmd -S localhost -U sa -i sql/schema.sql

# 4. Xem có biến .env mới cần thêm không
diff .env .env.example

# 5. Khởi động lại
pm2 restart dss-vn
pm2 status      # phải thấy "online", KHÔNG phải liên tục "restart"/"errored"
```

Vì toàn bộ dữ liệu đã nằm trong SQL Server, việc cập nhật giao diện/code
**không làm mất dữ liệu người dùng đã nhập** — kể cả khi có chạy lại
`schema.sql` (script chỉ thêm mới, không xoá/ghi đè dữ liệu).

> ⚠️ **Lỗi thường gặp: web báo 502/503 sau khi cập nhật code, không truy cập
> được.** Nguyên nhân hầu hết là bỏ sót bước `npm install`. Cách kiểm tra và
> khắc phục:
> ```bash
> pm2 logs dss-vn --lines 50 --err   # tìm dòng "Cannot find module ..."
> cd /opt/dss-vn && npm install
> pm2 restart dss-vn
> ```
> Sau khi sửa, mở `GET /api/health` (mục 12) để xác nhận server đã lên và
> đúng phiên bản mới trước khi báo cho người dùng thử lại.
