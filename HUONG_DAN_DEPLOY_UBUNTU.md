# HƯỚNG DẪN TRIỂN KHAI VPDT (VĂN PHÒNG ĐIỆN TỬ) TRÊN UBUNTU SERVER
### Node.js + SQL Server (MSSQL)

---

## 0. Tổng quan kiến trúc

```
[Trình duyệt người dùng]
        │  HTTP(S) (qua Nginx cổng 80/443, cookie phiên đăng nhập httpOnly)
        ▼
[Ubuntu Server]
   ├─ Nginx — reverse proxy cổng 80/443 → 127.0.0.1:3000 (mục 9b)
   ├─ Node.js (Express, chạy dưới PM2) — port 3000 — phục vụ giao diện + API,
   │  xác thực bằng JWT ký ở server (xem mục 6)
   └─ SQL Server (MSSQL) — port 1433 — lưu trữ dữ liệu (dbo.AppData + các bảng
      riêng theo loại hồ sơ: dbo.SystemLogs, dbo.Tasks, dbo.Records)
```

**Đặc điểm kiến trúc cần biết trước khi triển khai:**

- **Xác thực hoàn toàn ở phía SERVER.** Mật khẩu lưu dạng hash (bcrypt, không
  đọc lại được nguyên văn dù có quyền truy cập CSDL trực tiếp). Đăng nhập cấp
  1 phiên qua cookie JWT httpOnly, ký bằng `JWT_SECRET` — biến này **bắt buộc
  phải có trong `.env`, server sẽ không khởi động nếu thiếu** (xem mục 6). Có
  giới hạn số lần đăng nhập sai liên tiếp + khoá tạm tài khoản.
- **Cookie phiên đăng nhập mặc định bắt buộc HTTPS** (`COOKIE_SECURE=true`).
  Hướng dẫn này đi thẳng qua Nginx (mục 9) nên giữ nguyên mặc định `true` —
  chỉ đổi `false` nếu bạn cố tình bỏ qua Nginx và chạy thẳng qua
  `http://<ip>:3000` trong mạng nội bộ hoàn toàn tin cậy (xem cảnh báo lại ở
  mục 6).
- **Toàn bộ thao tác tạo/sửa/xoá/duyệt hồ sơ nghiệp vụ** đều được SERVER tự
  xác minh lại quyền + đúng bước quy trình trước khi ghi — không chỉ dựa vào
  ẩn/hiện nút trên giao diện.
- **Dữ liệu nghiệp vụ** (Văn bản trình, Tài liệu, Hợp đồng, Đăng ký xe, Đề
  xuất văn phòng, Công việc, Báo cáo định kỳ...) nằm trong các bảng riêng có
  khoá đúng từng dòng (`dbo.SystemLogs`, `dbo.Tasks`, `dbo.Records`).
  `dbo.AppData` chỉ còn giữ dữ liệu cấu hình (người dùng, phân quyền, quy
  trình mẫu, cấu hình email...). `schema.sql` (mục 4) tạo sẵn đầy đủ các bảng
  này — **không cần chạy tay thêm gì khác, không cần seed dữ liệu tay**, ứng
  dụng tự seed dữ liệu mặc định khi khởi động lần đầu (mục 8).

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
  -p 1433:1433 --name vpdt-mssql --restart unless-stopped \
  -v vpdt-mssql-data:/var/opt/mssql \
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
sudo mkdir -p /opt/vpdt
sudo chown $USER:$USER /opt/vpdt
cd /opt/vpdt
# Copy TOÀN BỘ nội dung thư mục server/ đã cung cấp vào đây (scp/rsync/git clone từ máy local)

npm install
```

`npm install` đọc `package.json` và cài đủ mọi gói ứng dụng cần (Express,
mssql, bcryptjs, exceljs...) — bỏ sót bước này ở lần dựng đầu tiên khiến
server báo lỗi `Cannot find module '...'` và thoát ngay lúc khởi động (xem
cảnh báo tương tự ở mục 12 cho các lần cập nhật code sau này).

---

## 4. Tạo Database và bảng dữ liệu

Từ trong thư mục `/opt/vpdt` (đã có `sql/schema.sql` từ mục 3):

```bash
cd /opt/vpdt/sql
sqlcmd -S localhost -U sa -P 'Your_Strong_Password_Here' -i schema.sql
```

Nếu dùng Docker (Lựa chọn B ở mục 2), chạy `sqlcmd` từ máy host trỏ
`-S localhost,1433`, hoặc `docker exec` vào container rồi chạy từ trong đó.
Nếu dùng SQL Server có sẵn ở máy khác (Lựa chọn C), đổi `-S localhost` thành
đúng IP máy chủ đó.

Script này **an toàn để chạy lại nhiều lần** (chỉ tạo bảng nào chưa có,
không đụng dữ liệu cũ) — sẽ:
- Tạo database `VPDT_DMS`
- Tạo bảng `dbo.AppData` (dữ liệu cấu hình — mỗi collection 1 dòng JSON)
- Tạo `dbo.SystemLogs`, `dbo.Tasks`, `dbo.Records` (dữ liệu hồ sơ nghiệp vụ —
  mỗi bản ghi 1 dòng riêng, xem ghi chú kiến trúc ở mục 0)

Dữ liệu mặc định (phòng ban, user admin, quy trình mẫu...) sẽ được **tự động
seed khi server Node.js khởi động lần đầu** (mục 8) — không cần chạy tay.

---

## 5. Kiểm tra kết nối SQL Server trước khi cấu hình ứng dụng

```bash
sqlcmd -S localhost -U sa -P 'Your_Strong_Password_Here' -Q "SELECT name FROM sys.databases;"
```

Phải thấy `VPDT_DMS` trong danh sách trả về. Nếu lỗi kết nối ở bước này, xử
lý dứt điểm trước khi sang mục 6 — mọi lỗi kết nối DB sau này (mục 8, mục 9)
đều bắt nguồn từ đây.

---

## 6. Cấu hình kết nối SQL Server + xác thực đăng nhập

```bash
cd /opt/vpdt
cp .env.example .env
nano .env
```

Điền đúng thông tin (các dòng dưới là **bắt buộc**, phần còn lại trong
`.env.example` đã copy sẵn qua `.env` — để nguyên comment, chỉ sửa giá trị
cần thiết):

```
PORT=3000

# --- Xác thực đăng nhập (BẮT BUỘC — server sẽ không khởi động nếu thiếu JWT_SECRET) ---
JWT_SECRET=change-me-to-a-long-random-string
COOKIE_SECURE=true

# --- Kết nối SQL Server ---
DB_SERVER=localhost          # hoặc IP máy chủ SQL Server nếu chạy riêng (Lựa chọn C ở mục 2)
DB_PORT=1433
DB_NAME=VPDT_DMS
DB_USER=sa
DB_PASSWORD=Your_Strong_Password_Here
DB_ENCRYPT=false
DB_TRUST_CERT=true
```

> ⚠️ `DB_ENCRYPT=false` chỉ chấp nhận được khi SQL Server và server ứng dụng cùng nằm trong 1 phân
> đoạn mạng tin cậy duy nhất (không đi qua firewall/router trung gian nào, kể cả nội bộ) — server sẽ
> in cảnh báo lúc khởi động nếu vẫn để `false`. Đổi thành `true` ngay khi kiến trúc có server DB/app
> tách riêng (khác máy, khác VLAN, đi qua firewall dù vẫn trong mạng công ty) — xem hướng dẫn bật tại
> mục 10.4.

Tạo `JWT_SECRET` bằng lệnh:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Đây là khoá ký phiên đăng nhập (JWT) — **PHẢI là chuỗi ngẫu nhiên dài, giữ
kín, và khác nhau giữa các môi trường** (dev/staging/production). Đổi giá trị
này sẽ khiến mọi phiên đăng nhập đang mở bị đăng xuất (không sao, chỉ cần
đăng nhập lại) — hữu ích nếu nghi ngờ khoá đã lộ.

> ⚠️ **`COOKIE_SECURE=true` (mặc định) yêu cầu truy cập qua HTTPS/qua Nginx
> đúng cấu hình ở mục 9.** Nếu bạn cố tình bỏ qua mục 9 và chạy thẳng qua
> `http://<ip>:3000` (chỉ nên làm trong mạng nội bộ hoàn toàn tin cậy), phải
> đổi thành `COOKIE_SECURE=false` — nếu không, trình duyệt sẽ không lưu lại
> cookie phiên đăng nhập và người dùng **không đăng nhập được dù nhập đúng
> mật khẩu** (không có thông báo lỗi rõ ràng, chỉ tự động bị coi như chưa
> đăng nhập ngay sau khi vào được màn chính).

> ⚠️ Không commit file `.env` lên Git — chứa mật khẩu SQL Server và khoá
> `JWT_SECRET`.

**Bỏ qua `TRUST_PROXY` và `ALLOWED_ORIGINS` ở bước này** — 2 biến đó chỉ cần
đặt sau khi dựng xong Nginx, xem lại ở mục 9c (dễ quên vì làm ở đây trước
khi có Nginx sẽ không có tác dụng gì, phải quay lại sau).

Các biến khác trong `.env.example` (`DB_POOL_*`, `APPDATA_CACHE_TTL_MS`) đều
có giá trị mặc định hợp lý — chỉ cần điền khi bạn thực sự cần chỉnh khác mặc
định, xem chú thích trong chính file `.env.example` và mục 10.3.

---

## 7. Cấu hình gửi email thật (SMTP)

Toàn bộ cấu hình — kể cả tài khoản/mật khẩu đăng nhập SMTP — nay cấu hình được **trực tiếp trên web**
tại màn **Quản trị > Cấu Hình Email**, không cần đụng `.env` hay khởi động lại server. Mật khẩu SMTP
được mã hoá 2 chiều trước khi lưu vào CSDL bằng khoá `EMAIL_ENCRYPTION_KEY` trong `.env`:

```
EMAIL_ENCRYPTION_KEY=<chuỗi ngẫu nhiên dài, tạo bằng lệnh bên dưới>
```
Tạo nhanh: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Đặt biến này
**trước khi** cấu hình mật khẩu SMTP qua web lần đầu — nếu bạn chỉ dùng máy chủ SMTP không yêu cầu
xác thực, hoặc vẫn muốn giữ tài khoản trong `.env` (đường lùi cũ, xem bên dưới), có thể bỏ qua biến
này.

Màn Cấu Hình Email có **3 nút Mã Hoá** (Không mã hoá/TLS/SSL) tương ứng port chuẩn 25/587/465 — bấm 1
nút sẽ tự đổi Port sang giá trị chuẩn (trừ khi Port đang là 1 giá trị tuỳ chỉnh khác). Có nút
**"Gửi Thử"** ngay trên form để xác minh cấu hình đúng trước khi Lưu, không cần dò log server.

Mặc định hệ thống chỉ **mô phỏng** gửi email (ghi vào Nhật ký hệ thống, không gửi thật) cho tới khi
nhập SMTP Server ở màn này.

**Trường hợp 1 — Gmail (cần xác thực):** vào **Quản trị > Cấu Hình Email**, điền
`SMTP Server = smtp.gmail.com`, `Port = 587`, chọn nút mã hoá **TLS**, bật "Máy chủ SMTP yêu cầu xác
thực" rồi điền Tài khoản = email Gmail, Mật khẩu = "Mật khẩu ứng dụng" (App Password) tạo tại
`https://myaccount.google.com/apppasswords` (Google đã chặn đăng nhập SMTP bằng mật khẩu thường).

**Trường hợp 2 — mail relay nội bộ công ty (KHÔNG cần xác thực):** điền Host/Port/Email người gửi
thật của relay, KHÔNG bật "Máy chủ SMTP yêu cầu xác thực". Nếu relay dùng chứng chỉ TLS tự ký
(self-signed), thêm trong `.env`:
```
SMTP_TLS_REJECT_UNAUTHORIZED=false
```

**Đường lùi `.env` (`SMTP_USER`/`SMTP_PASS`):** chỉ dành cho máy chủ đã deploy từ trước khi có tính
năng cấu hình tài khoản trên web — nếu màn Cấu Hình Email chưa lưu tài khoản nào (chưa bật "Máy chủ
SMTP yêu cầu xác thực"), hệ thống tự dùng `SMTP_USER`/`SMTP_PASS` trong `.env` nếu có. Không bắt buộc
cho cài đặt mới.

> ⚠️ Sau khi sửa `.env` (`EMAIL_ENCRYPTION_KEY`/`SMTP_USER`/`SMTP_PASS`/`SMTP_TLS_REJECT_UNAUTHORIZED`),
> cần khởi động lại server (`pm2 restart vpdt` hoặc tương đương) để áp dụng. Mọi thay đổi trên màn
> Cấu Hình Email (Host/Port/Mã hoá/Tài khoản SMTP/Email người gửi/Bật-tắt) thì KHÔNG cần khởi động lại.

---

## 8. Chạy thử (kiểm tra trước khi đưa vào production)

```bash
cd /opt/vpdt
npm start
```

Kỳ vọng thấy log:
```
⏳ Đang kết nối SQL Server...
✅ Đã kết nối SQL Server: localhost:1433 - DB: VPDT_DMS
⏳ Đang kiểm tra / khởi tạo dữ liệu mặc định...
   ↳ Seed mặc định cho "depts"
   ↳ Seed mặc định cho "users"
   ... (nhiều dòng seed cho lần chạy đầu tiên)
✅ VPDT server đang chạy tại http://localhost:3000
```

Mở trình duyệt: `http://<ip-server>:3000` — đăng nhập thử với tài khoản mặc định:
- `admin / 123456` (Quản trị viên - full quyền)
- `nv_nhansu / 123456`, `ks_kiemsoat / 123456`, `sep_duyet / 123456`

Nếu đăng nhập không ăn (vào được màn chính rồi lại bị đá về màn đăng nhập),
xem lại cảnh báo `COOKIE_SECURE` ở mục 6 — nguyên nhân hầu hết là do đó (đang
thử qua `http://` thuần mà `COOKIE_SECURE` vẫn để `true`).

Mật khẩu các tài khoản mặc định được lưu **đã băm bằng bcrypt** (không phải
plain-text). Server tự động phát hiện tài khoản nào còn dùng mật khẩu mặc định
`123456` và **bắt buộc đổi mật khẩu ngay lần đăng nhập đầu tiên** (màn hình
đổi mật khẩu hiện ra, không thể bỏ qua) — không cần bạn phải nhớ tự đổi thủ
công, nhưng vẫn nên đổi ngay khi đưa vào sử dụng thật cho đúng người dùng thật.

Dừng lại (Ctrl+C) sau khi xác nhận chạy được — bước này chỉ để kiểm tra
trước khi chuyển sang chạy nền bằng PM2 (mục 9).

---

## 9. Chạy production ổn định bằng PM2 + Nginx (reverse proxy, HTTPS)

### 9a. PM2 (giữ tiến trình chạy nền, tự khởi động lại khi lỗi/reboot server)

**Ứng dụng nội bộ, ít người dùng đồng thời (dưới ~100)** — chạy 1 tiến trình đơn (fork mode) là đủ:

```bash
sudo npm install -g pm2

cd /opt/vpdt
# NODE_ENV=production BẮT BUỘC — thiếu biến này, lỗi máy chủ (500) sẽ trả kèm chi tiết exception thật
# (có thể chứa lỗi SQL, đường dẫn file nội bộ...) ra thẳng cho trình duyệt thay vì chỉ ghi vào log server
# (xem lib/errorResponse.js). KHÔNG bỏ qua bước này khi deploy lên máy chủ thật.
NODE_ENV=production pm2 start server.js --name vpdt

# Tự khởi động lại khi server reboot
pm2 startup systemd
pm2 save
```

**Public cho nhiều người dùng đồng thời (vài trăm người trở lên)** — nên chạy CLUSTER MODE thay vì
lệnh trên, tận dụng hết số nhân CPU của máy chủ (Node đơn luồng, 1 tiến trình chỉ dùng 1 nhân):

```bash
cd /opt/vpdt
pm2 start ecosystem.config.js --env production

pm2 startup systemd
pm2 save
```

`ecosystem.config.js` (có sẵn trong repo) chạy `instances: 'max'` — PM2 tự chạy đúng bằng số nhân CPU
thật của máy. Ứng dụng đã thiết kế stateless giữa các request (xác thực qua JWT + tra DB, không giữ
session trong bộ nhớ tiến trình) nên chạy nhiều tiến trình an toàn, không cần cấu hình sticky session ở
Nginx. Job định kỳ (nhắc hết hạn hợp đồng) tự nhận biết chỉ chạy ở 1 tiến trình, không bị gửi email
trùng lặp N lần theo số tiến trình.

**⚠️ Lưu ý pool kết nối SQL Server khi chạy cluster mode**: mỗi tiến trình giữ 1 pool kết nối RIÊNG
(mặc định tối đa 20 — `DB_POOL_MAX` trong `.env`, xem mục 6). Chạy 4 tiến trình × 20 = tối đa 80 kết
nối đồng thời tới SQL Server — kiểm tra SQL Server (RAM/CPU/giới hạn kết nối theo license, đặc biệt nếu
dùng bản Express có giới hạn) có đủ sức chịu; nếu không, hạ `DB_POOL_MAX` xuống (vd. 10) để tổng kết
nối across mọi tiến trình ở mức hợp lý.

Các lệnh quản lý thường dùng (giống nhau cho cả 2 cách chạy ở trên):
```bash
pm2 status              # xem trạng thái (cluster mode sẽ thấy nhiều dòng "vpdt" — mỗi dòng 1 tiến trình)
pm2 logs vpdt           # xem log realtime
pm2 restart vpdt        # khởi động lại sau khi cập nhật code
pm2 stop vpdt
```

### 9b. Nginx (reverse proxy cổng 80/443 → 3000)

```bash
sudo apt-get install -y nginx
sudo nano /etc/nginx/sites-available/vpdt
```

Nội dung — `client_max_body_size` PHẢI ≥ `UPLOAD_MAX_MB` trong `.env` (mặc
định `UPLOAD_MAX_MB=20` nếu không đặt — xem `.env.example`), nếu không file
người dùng tải lên nằm giữa 2 giới hạn này sẽ bị Nginx chặn với lỗi
"413 Request Entity Too Large" mơ hồ thay vì thông báo rõ ràng của ứng dụng:

```nginx
server {
    listen 80;
    server_name vpdt.congty.local;   # đổi thành domain/IP nội bộ của bạn

    client_max_body_size 20M;        # khớp UPLOAD_MAX_MB (.env) — đổi cả 2 cùng lúc nếu cần nâng

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
sudo ln -s /etc/nginx/sites-available/vpdt /etc/nginx/sites-enabled/
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

**Về HTTPS:** `COOKIE_SECURE` mặc định là `true` (bắt buộc HTTPS) — cookie
phiên đăng nhập sẽ **không được trình duyệt gửi lên** nếu truy cập qua `http://`
thường (không phải `https://`), khiến đăng nhập không giữ được phiên. Vì vậy
sau khi cấu hình Nginx, bạn cần bật HTTPS bằng 1 trong 2 cách trước khi đưa
vào dùng thật:
- Có domain public trỏ về server: dùng `certbot` (Let's Encrypt, miễn phí).
- Chỉ dùng nội bộ (LAN/VPN, không có domain public): tự cấp chứng chỉ qua CA
  nội bộ của công ty, hoặc dùng chứng chỉ self-signed cho môi trường thử
  nghiệm (trình duyệt sẽ cảnh báo "không an toàn", chấp nhận thủ công 1 lần).

Nếu thực sự không thể bật HTTPS (ví dụ đang thử nghiệm nhanh trong LAN kín),
có thể tạm đặt `COOKIE_SECURE=false` — nhưng khi đó phiên đăng nhập (cookie
JWT) đi dạng cleartext trên mạng, **không nên dùng cấu hình này khi đã có dữ
liệu thật của nhân viên**.

### 9c. Bật `TRUST_PROXY` sau khi có Nginx (BẮT BUỘC, dễ bỏ sót)

Giờ mọi request tới Node đều đi qua Nginx trên CÙNG máy — nếu không khai báo
`TRUST_PROXY`, Express sẽ thấy MỌI người dùng đều gọi từ cùng 1 địa chỉ
(`127.0.0.1`, IP của Nginx) thay vì IP thật của từng người. Hậu quả: giới hạn
đăng nhập sai/khoá tạm tài khoản và rate-limit tính GỘP CHUNG cho cả công ty
thay vì theo từng người — 1 người gõ sai mật khẩu 5 lần có thể khiến TOÀN BỘ
người dùng khác bị chặn tạm thời.

```bash
cd /opt/vpdt
nano .env
```
Bỏ dấu `#` trước dòng sau (đã có sẵn, chỉ đang comment):
```
TRUST_PROXY=1
```
Rồi khởi động lại:
```bash
pm2 restart vpdt
```

### 9d. Cài đặt fail2ban (khuyến nghị khi mở ra Internet công khai)

Ứng dụng đã tự chặn dò mật khẩu ở tầng của mình (rate-limit + khoá tài khoản,
xem mục 10.1), nhưng mỗi lượt vẫn phải đi hết qua Nginx + Node trước khi bị
từ chối. fail2ban thêm 1 lớp CHẶN Ở FIREWALL — đọc log truy cập Nginx, phát
hiện 1 địa chỉ IP có hành vi bất thường lặp lại (đăng nhập sai nhiều lần,
hoặc bị chính ứng dụng trả về 429 quá nhiều lần) thì cấm hẳn IP đó kết nối
tới server trong 1 khoảng thời gian — đỡ tải cho tầng ứng dụng, đồng thời
gây khó hơn cho công cụ dò quét tự động so với chỉ bị "từ chối nhẹ nhàng".

```bash
sudo apt-get install -y fail2ban
```

Repo đã có sẵn 2 bộ lọc + cấu hình jail mẫu tại `deploy/fail2ban/` — chỉ cần
copy sang đúng thư mục fail2ban đọc:

```bash
sudo cp deploy/fail2ban/filter.d/vpdt-login.conf     /etc/fail2ban/filter.d/
sudo cp deploy/fail2ban/filter.d/vpdt-ratelimit.conf /etc/fail2ban/filter.d/
sudo cp deploy/fail2ban/jail.d/vpdt.conf             /etc/fail2ban/jail.d/
sudo systemctl restart fail2ban
```

Kiểm tra đã chạy đúng:
```bash
sudo fail2ban-client status vpdt-login
sudo fail2ban-client status vpdt-ratelimit
```

Ngưỡng mặc định trong `deploy/fail2ban/jail.d/vpdt.conf` (10 lần đăng nhập
sai hoặc 15 lần bị 429 trong 10 phút thì cấm 1 giờ) là điểm khởi đầu hợp lý
— chỉnh trực tiếp file này (`maxretry`/`findtime`/`bantime`) theo thực tế
lưu lượng của công ty bạn nếu cần, không cần sửa gì ở code ứng dụng.

> Lưu ý: nếu server của bạn còn đứng sau 1 lớp proxy/CDN khác nữa (ví dụ
> Cloudflare) TRƯỚC Nginx, `$remote_addr` trong log Nginx sẽ là IP của lớp
> đó chứ không phải IP người dùng thật — cần cấu hình Nginx `real_ip_header`
> tương ứng trước khi fail2ban chặn đúng IP. Không áp dụng cho kiến trúc mặc
> định ở mục 9b (Nginx là lớp nhận traffic Internet đầu tiên).

---

## 10. Tình trạng bảo mật hiện tại và các việc cần làm trước khi public

### 10.1. Đã hoàn thiện ở tầng ứng dụng/server

- **Xác thực phía server**: đăng nhập kiểm tra mật khẩu bằng bcrypt, phát
  cookie phiên JWT `httpOnly` — không còn so sánh mật khẩu ở JS trình duyệt.
  Mọi API nghiệp vụ đều bắt buộc có phiên hợp lệ, server tự kiểm tra lại
  quyền/trạng thái tài khoản (đã bị vô hiệu hoá hay chưa) trên **mỗi request**
  chứ không chỉ tin nội dung JWT.
- **Chống dò mật khẩu**: giới hạn số lần đăng nhập sai theo IP (chặn 15 phút
  nếu vượt ngưỡng) **và** khoá riêng theo từng tài khoản sau 5 lần sai liên
  tiếp — 2 lớp độc lập, xem lưu ý bắt buộc về `TRUST_PROXY` ở mục 9c.
- **Chính sách mật khẩu**: mật khẩu mới (khi admin tạo/đặt lại) phải tối
  thiểu 8 ký tự, không nằm trong danh sách mật khẩu phổ biến/dễ đoán. Tài
  khoản còn dùng mật khẩu mặc định `123456` bị tự động đánh dấu **bắt buộc
  đổi mật khẩu ngay lần đăng nhập kế tiếp**, chặn ở cả giao diện lẫn server
  (không thể bỏ qua bằng cách sửa code phía trình duyệt).
- **HTTP security headers**: đã bật CSP, `X-Frame-Options`, `X-Content-Type-Options`,
  HSTS, ẩn `X-Powered-By`, ... (xem `server/lib/securityHeaders.js`).
- **Chống xung đột dữ liệu (race condition)**: các thao tác lưu dùng optimistic
  concurrency (If-Match/409) hoặc khoá dòng (`WITH UPDLOCK, HOLDLOCK`) cho các
  thao tác cần cộng dồn/append an toàn (ví dụ nhật ký hệ thống).
- **Connection pool** đã tinh chỉnh để chịu tải tốt hơn (xem mục 6, biến
  `DB_POOL_*` trong `.env.example`).

### 10.2. Việc bạn cần tự làm khi triển khai

1. Đặt `JWT_SECRET` là chuỗi ngẫu nhiên dài, **khác nhau giữa các môi trường**
   (mục 6) — không dùng lại giá trị mẫu trong `.env.example`.
2. Bật HTTPS thật (`COOKIE_SECURE=true` là mặc định, xem lưu ý ở mục 9b) trước
   khi cho người dùng thật đăng nhập — nếu không, cookie phiên không hoạt
   động qua `http://` thường.
3. Nếu dùng Nginx (khuyến nghị, mục 9b): **bắt buộc** đặt `TRUST_PROXY=1` và
   cấu hình `proxy_set_header X-Forwarded-For ...` (mục 9c) — thiếu bước này
   khiến giới hạn đăng nhập theo IP mất tác dụng thực tế dù không báo lỗi gì.
4. **Chỉ mở port 3000/1433 trong mạng nội bộ** (LAN/VPN công ty) nếu không
   qua Nginx + HTTPS; không expose thẳng port 3000/1433 ra Internet.
5. **Đổi mật khẩu tài khoản mặc định** cho đúng người dùng thật ngay sau khi
   triển khai (hệ thống sẽ tự bắt buộc đổi ở lần đăng nhập đầu, xem mục 8,
   nhưng vẫn nên chủ động rà lại danh sách tài khoản trước khi public).
6. **Backup định kỳ CẢ 2 nơi, không chỉ SQL Server:**
   - **Database**: `sqlcmd`/SQL Server Agent job hoặc script
     `BACKUP DATABASE VPDT_DMS TO DISK = ...` chạy cron hàng ngày.
   - **Thư mục `/opt/vpdt/uploads/`**: file đính kèm (Tài liệu, Tờ trình, Hợp
     đồng, tài liệu ký...) lưu VẬT LÝ ở đây, KHÔNG nằm trong SQL Server —
     backup riêng DB mà quên thư mục này thì phục hồi xong vẫn mất toàn bộ
     file đính kèm (chỉ còn đường dẫn trong DB trỏ tới file không còn tồn
     tại). `rsync`/`tar` định kỳ ra nơi lưu trữ khác cùng lịch với backup DB.
7. **Thử nghiệm 1 lần tình huống 2 người thao tác đồng thời** trước khi
   thông báo cho toàn công ty dùng thật — ví dụ 2 người cùng đặt trùng 1
   phòng họp/khung giờ từ 2 tài khoản gần như đồng thời: chỉ 1 yêu cầu phải
   thành công, yêu cầu còn lại báo lỗi trùng lịch rõ ràng (không phải lỗi 500
   chung chung). Hệ thống đã có cơ chế khoá ở tầng CSDL cho các trường hợp
   này nhưng nên tự xác nhận 1 lần trên đúng SQL Server thật đang dùng.

### 10.3. Giới hạn kiến trúc + kết quả load test khi mở rộng quy mô người dùng

Thiết kế lưu trữ ban đầu (port thẳng từ `localStorage`) dồn TOÀN BỘ collection
vào 1 bản ghi JSON duy nhất trong `dbo.AppData`. Từ "Bước 6" trở đi, các
collection tăng trưởng nhanh/hay ghi nhiều nhất đã được TÁCH sang bảng riêng,
mỗi bản ghi = 1 dòng thật (khoá đúng 1 dòng thay vì cả collection khi ghi) —
xem chi tiết ở đầu `server/sql/schema.sql`:

- `dbo.SystemLogs` — nhật ký hệ thống
- `dbo.Tasks` — Công việc
- `dbo.Records` — submissions/docs/carRegs/officeReqs/contracts/meetings/
  meetingMinutes/internalPosts/paymentRequests/vppPeriods/vppRegistrations/
  reportPeriods/reportEntries/reportSlideTemplates (phân biệt bằng cột
  `Collection`, mỗi bản ghi vẫn 1 dòng riêng)

Chỉ còn dữ liệu CẤU HÌNH (người dùng, phân quyền, quy trình phê duyệt theo
phòng ban, danh mục...) còn ở dạng 1-blob-JSON/collection trong `dbo.AppData`
— các collection này thay đổi ít, không phải điểm nghẽn ghi.

**Kết quả load test thật với 500 người dùng đồng thời** (k6, tháng 8/2026,
xem chi tiết tại PR sửa lỗi cùng đợt): `GET /api/data` — API nặng nhất, gọi
mỗi lần mở app/làm mới dữ liệu — đạt **trung vị 7ms, p95 30ms, 0% lỗi** ở 500
người dùng đồng thời, **VỚI ĐIỀU KIỆN chạy PM2 cluster mode (mục 9a)**. Chạy
1 tiến trình đơn (`node server.js` hoặc `pm2 start server.js` không qua
`ecosystem.config.js`) ở cùng mức tải: trung vị 7s, p95 27s — vẫn không lỗi
nhưng chậm rõ rệt. **Kết luận: bắt buộc dùng cluster mode (mục 9a) trước khi
public cho từ khoảng 100-200 người dùng đồng thời trở lên** — không phải tuỳ
chọn tối ưu thêm.

Điểm nghẽn đo được là CPU xử lý JSON (đọc + lọc quyền xem + serialize hàng
trăm KB mỗi request), KHÔNG phải database (SQL Server chỉ ~38% CPU lúc app
nghẽn nặng nhất) — cluster mode phát huy tác dụng vì đúng loại tải này (CPU-
bound, phân chia được qua nhiều tiến trình) chứ không phải I/O-bound.

Trước khi public rộng, ngoài việc chạy cluster mode cần lưu ý thêm các thông số tinh chỉnh được:

- **`DB_POOL_MAX`** (`.env`, mục 6) — cân đối với số tiến trình cluster, xem lưu ý ở mục 9a.
- **`APPDATA_CACHE_TTL_MS`** (mặc định 3000 = 3 giây, `.env`, tuỳ chọn) — thời gian cache tạm trong bộ
  nhớ cho các lượt đọc lặp lại nhiều (vd. `requireAuth()` tra trạng thái tài khoản ở mỗi request có xác
  thực). Tăng lên nếu vẫn thấy nghẽn DB dưới tải cao, giảm xuống (hoặc đặt `0`) nếu cần thay đổi quyền/
  vô hiệu hoá tài khoản có hiệu lực ngay lập tức tuyệt đối, chấp nhận đổi lại tải DB cao hơn.
- **Rate limit toàn cục** (`server.js`, mặc định 600 request/phút, khoá theo người dùng đã đăng nhập
  chứ không theo IP) — nếu vẫn thấy người dùng bị chặn nhầm (lỗi "gửi quá nhiều yêu cầu") lúc dùng bình
  thường, có thể nâng thêm `limit` trong `globalApiRateLimiter`.

Giới hạn còn lại (không phải lỗi, chỉ là ranh giới thiết kế hiện tại): nếu
công ty phát triển tới quy mô hàng nghìn người dùng đồng thời thao tác liên
tục, các collection CẤU HÌNH còn ở `dbo.AppData` (đặc biệt "users" nếu công
ty có hàng nghìn tài khoản) sẽ cần cân nhắc tách bảng tương tự — không cấp
thiết ở quy mô vài trăm người dùng đã kiểm chứng ở trên. Dù cấu hình đúng
theo hướng dẫn này không đảm bảo chịu tải đúng thực tế của công ty bạn — nên
tự làm 1 đợt load test riêng (k6/Artillery: đăng nhập + các thao tác CRUD phổ
biến) nhắm vào server thật trước khi công bố chính thức.

### 10.4. Bật mã hoá kết nối SQL Server (`DB_ENCRYPT=true`) khi app và DB tách máy/VLAN

Áp dụng khi kiến trúc của bạn giống mô hình đã rà soát: máy chủ DB nằm sau
firewall riêng, máy chủ app là phần cứng khác cũng sau firewall riêng, 2 máy
ở 2 VLAN khác nhau, firewall chỉ cho phép app → DB kết nối tới đúng port
1433. Đây KHÔNG còn là "1 phân đoạn mạng tin cậy duy nhất" như điều kiện
chấp nhận `DB_ENCRYPT=false` nêu ở mục 6 — traffic đi qua firewall/router
trung gian, dữ liệu (bao gồm mật khẩu SQL Server lúc xác thực) truyền ở dạng
không mã hoá qua chặng đó nếu vẫn để `false`.

**Không cần cài đặt gì thêm trên SQL Server** — SQL Server tự sinh sẵn 1
chứng chỉ TLS self-signed ngay từ lần khởi động đầu tiên (không cần bật
"Force Encryption" trong SQL Server Configuration Manager), driver `mssql`
phía app chỉ cần chủ động yêu cầu mã hoá:

1. Sửa `.env` trên máy chủ app:
   ```
   DB_ENCRYPT=true
   DB_TRUST_CERT=true
   ```
   Giữ nguyên `DB_TRUST_CERT=true` — vì dùng chứng chỉ self-signed (không có
   CA nào ký), driver cần được phép bỏ qua bước xác minh chuỗi chứng chỉ,
   nếu không sẽ báo lỗi kết nối `self signed certificate`.
2. `pm2 restart vpdt` (hoặc tên process bạn đặt ở mục 9a).
3. Kiểm tra log khởi động — dòng cảnh báo `⚠️ DB_ENCRYPT chưa bật...` (xem
   `server/db.js`) phải biến mất, và vẫn thấy `✅ Đã kết nối SQL Server`.

**Giới hạn cần biết**: cách trên mã hoá được đường truyền (chống nghe lén
thụ động nếu ai đó chen được vào chặng firewall giữa 2 VLAN), nhưng KHÔNG
xác thực được SQL Server có đúng là SQL Server thật hay không (không chống
được tấn công chủ động kiểu man-in-the-middle giả làm SQL Server) — vì
`DB_TRUST_CERT=true` bỏ qua bước xác minh CA. Với topology đã mô tả (firewall
chỉ cho phép đúng 1 đường app → DB, không có thiết bị lạ chen giữa được),
đây là đánh đổi hợp lý. Nếu muốn mã hoá + xác thực đầy đủ, cần cài chứng chỉ
TLS do CA nội bộ/công khai ký cho SQL Server rồi đổi `DB_TRUST_CERT=false`
— bước này phức tạp hơn (quản lý CA, gia hạn chứng chỉ định kỳ) nên không
bắt buộc ở quy mô hiện tại, chỉ nêu để biết hướng nâng cấp sau này.

### 10.5. Bật CAPTCHA chống bot ở trang đăng nhập (khuyến nghị khi mở ra Internet công khai)

Áp dụng khi hệ thống không giới hạn truy cập qua VPN/whitelist IP (ai cũng
vào được trang đăng nhập từ Internet) — lúc đó các lớp chống dò mật khẩu ở
mục 10.1 (khoá theo IP/tài khoản) vẫn đứng vững, nhưng CAPTCHA chặn được bot
**từ bước sớm hơn** (trước khi tốn tài nguyên xử lý đăng nhập), đồng thời
gây khó cho các công cụ dò mật khẩu tự động hàng loạt.

Dùng CAPTCHA số đơn giản — **tự vẽ + tự xác minh hoàn toàn trên server**
(`server/lib/captcha.js`), không cần đăng ký tài khoản/API key ở bất kỳ dịch
vụ ngoài nào: server sinh 1 mã 4 chữ số, vẽ ra ảnh SVG có nhiễu nhẹ (đường kẻ,
chấm, xoay lệch từng chữ số — đủ chặn kịch bản trích text thô, KHÔNG chống
được OCR chuyên biệt, chấp nhận được vì mục tiêu chỉ là thêm ma sát cho bot dò
mật khẩu hàng loạt), người dùng gõ lại đúng mã đó.

1. Điền vào `.env`:
   ```
   CAPTCHA_ENABLED=true
   ```
2. `pm2 restart vpdt`. Mở lại trang đăng nhập — khung "Mã xác nhận"
   (ảnh số + nút ↻ lấy mã khác) sẽ tự hiện dưới ô mật khẩu.

Không cấu hình (mặc định `false`) thì trang đăng nhập hoạt động y như
trước — không bắt buộc, chỉ khuyến nghị khi đã public hẳn ra Internet.

---

### 10.6. Bật đăng nhập/xác thực khi Duyệt bằng vân tay, Face ID (WebAuthn/FIDO2)

Cho phép đăng nhập bằng vân tay/Face ID trên điện thoại (thay gõ mật khẩu)
và thêm 1 mức xác thực lại khi Duyệt mới ("WEBAUTHN", song song
PASSWORD/OTP_EMAIL/PIN đã có ở mục 9. Người Duyệt). Vân tay **không bao giờ
rời khỏi thiết bị người dùng** — máy chủ chỉ lưu 1 public key + credential ID
(`lib/webauthn.js`), không lưu gì sinh trắc học thật.

**Bắt buộc máy chủ đang chạy qua HTTPS thật** (mục 9b/9c ở trên) — trình
duyệt không cấp API vân tay/Face ID qua `http://` thường (trừ
`http://localhost` lúc dev). Nếu server bạn đang chạy chế độ LAN nội bộ
không qua Nginx/HTTPS (`COOKIE_SECURE=false`), tính năng này sẽ không dùng
được cho tới khi có HTTPS thật — không cần tắt gì, nút liên quan tự ẩn phía
trình duyệt.

1. Điền vào `.env` (xem chú thích đầy đủ trong `.env.example`):
   ```
   WEBAUTHN_RP_ID=vpdt.company.com   # domain THẬT đang truy cập, không kèm https://, không kèm cổng
   WEBAUTHN_RP_NAME=HCRC Workspace   # tên hiển thị trong hộp thoại vân tay, không bắt buộc
   ```
   `WEBAUTHN_RP_ID` phải khớp **chính xác** domain người dùng gõ trên thanh
   địa chỉ — sai domain thì vân tay báo lỗi xác thực dù thao tác đúng. Đổi
   domain truy cập sau này (domain khác/subdomain khác) sẽ khiến mọi thiết bị
   đã đăng ký cũ ngừng dùng được, người dùng phải đăng ký lại.
2. `pm2 restart vpdt`. Mỗi người dùng tự đăng ký thiết bị của mình ở
   "⚙️ Cá Nhân Hóa → 🖐️ Đăng Nhập/Xác Thực Bằng Vân Tay, Face ID" (phải đăng
   nhập bằng mật khẩu ít nhất 1 lần trước — không có đường đăng ký vân tay
   cho tài khoản chưa xác minh).
3. (Tuỳ chọn) Ở mục "9. Người Duyệt" trong Quản trị, đổi mức xác thực khi
   Duyệt của 1 người sang "Yêu cầu vân tay/Face ID" — **chỉ chọn cho người đã
   tự đăng ký ít nhất 1 thiết bị**, chọn cho người chưa đăng ký sẽ khiến họ
   không Duyệt được cho tới khi đăng ký.

Không cấu hình (để trống `WEBAUTHN_RP_ID`, mặc định) thì hệ thống hoạt động y
như trước — không bắt buộc.

**Lỗi "Không thể đăng ký thiết bị vân tay"/"Không thể xác thực vân tay"** dù
đã cấu hình đúng `WEBAUTHN_RP_ID`: nếu server đứng sau 1 lớp reverse proxy
(Nginx, hoặc Cloudflare Tunnel — xem mục 9b) mà **thiếu `TRUST_PROXY`** trong
`.env`, Node sẽ đọc nhầm giao thức request là `http` dù trình duyệt gọi thật
qua `https`, khiến bước xác minh vân tay so khớp origin bị lệch và luôn báo
lỗi. Từ bản cập nhật này, lỗi sẽ hiện rõ nguyên nhân ngay trên màn hình
(khớp/lệch origin hay RP ID) thay vì 1 câu chung chung — làm theo đúng gợi ý
hiện ra: thường chỉ cần thêm `TRUST_PROXY=1` vào `.env` rồi `pm2 restart vpdt`.

---

### 10.7. Cài đặt ứng dụng lên màn hình chính (PWA)

Cho phép người dùng "cài" HCRC Workspace như 1 ứng dụng (icon riêng, mở
không qua trình duyệt) trên điện thoại/máy tính — **hoạt động tự động ngay
sau khi cập nhật code, không cần cấu hình `.env` hay bước thủ công nào**.
Giai đoạn này CHƯA làm thông báo đẩy (push notification), chỉ dừng ở cài đặt
+ phím tắt module.

- **Android/Chrome**: trình duyệt tự gợi ý cài đặt; người dùng cũng chủ động
  cài ở "⚙️ Cá Nhân Hóa → 📲 Cài Đặt Ứng Dụng → Cài Đặt Ngay". Sau khi cài,
  nhấn giữ icon app trên màn hình chính sẽ hiện các "phím tắt" nhảy thẳng vào
  module — admin chọn module nào hiện ở "Hệ Thống → Quản Trị → Quản Lý Danh
  Mục → 📲 Phím Tắt PWA" (tối đa 4 module, mặc định chưa chọn module nào).
- **iPhone/iPad (Safari)**: Apple không cho trình duyệt tự gợi ý cài như
  Android — người dùng phải làm thủ công qua Share → "Thêm vào MH chính",
  có hướng dẫn từng bước ngay trong "⚙️ Cá Nhân Hóa → 📲 Cài Đặt Ứng Dụng".
  Safari trên iOS cũng KHÔNG hỗ trợ menu phím tắt khi nhấn giữ icon (giới hạn
  của Apple, không phải thiếu sót) — chỉ mở được thẳng vào trang chủ.
- Bắt buộc máy chủ chạy HTTPS thật để cài đặt hoạt động đúng chuẩn trên điện
  thoại thật (cùng yêu cầu như CAPTCHA/WebAuthn ở trên) — chạy `http://` LAN
  nội bộ vẫn dùng bình thường được trên `localhost` lúc dev/test.

Không cần làm gì thêm ngoài `git pull` + `pm2 restart` — không có biến môi
trường mới, không đổi `schema.sql`, không thêm gói npm nào.

---

## 11. Kiểm tra sức khỏe hệ thống

Endpoint kiểm tra nhanh:
```
GET http://<ip-server>:3000/api/health
→ {"status":"ok","db":"connected","version":"1.42.0"}
```

`version` khớp đúng trường `version` trong `package.json` của bản code server
đang chạy — dùng để xác nhận sau khi cập nhật code (mục 12) đã áp dụng đúng
bản mới hay chưa, không cần đoán. Cùng số phiên bản này cũng hiện ở góc dưới
bên phải màn hình web (không cần đăng nhập), đối xứng với ghi chú bản quyền
ở góc dưới bên trái.

Dùng cho giám sát (uptime monitor, script cron cảnh báo qua email/Zalo nếu server down).

---

## 12. Cập nhật code sau này

**Chỉ copy code + `pm2 restart` là đủ CHỈ KHI** bản cập nhật không đổi gì
ngoài code (đa số các lần sửa giao diện/tính năng nhỏ là vậy). Với bản cập
nhật lớn hơn — đặc biệt khi máy chủ đã lâu chưa cập nhật (bỏ qua nhiều phiên
bản) — cần kiểm tra thêm 3 chỗ sau trước khi restart, vì code mới có thể yêu
cầu:

1. **`server/sql/schema.sql` đổi** — bảng/cột/index mới, hoặc sửa lỗi trong
   chính script này. An toàn chạy lại nhiều lần (mọi thay đổi đều bọc trong
   `IF OBJECT_ID(...) IS NULL`), nhưng **PHẢI chạy lại** nếu file này có thay
   đổi so với bản đang chạy, nếu không tính năng mới liên quan sẽ lỗi ngay khi
   dùng (thiếu bảng/cột/index).
2. **`server/.env.example` đổi** — biến môi trường mới hoặc đổi ý nghĩa. Một
   số biến bắt buộc để server khởi động được (như `JWT_SECRET`), số khác chỉ
   cần khi dùng đúng tính năng liên quan (ví dụ `EMAIL_ENCRYPTION_KEY` chỉ cần
   nếu dùng màn Cấu Hình Email trên web). So sánh `.env.example` mới với
   `.env` hiện tại của bạn (`diff .env server/.env.example` sau khi copy code
   mới) để biết biến nào cần thêm.
3. **`server/package.json` đổi `dependencies`** — cần chạy lại `npm install`
   trong thư mục `server/` trước khi restart, nếu không server có thể báo lỗi
   "Cannot find module" ngay khi khởi động.

**Quy trình cập nhật đầy đủ, an toàn cho mọi trường hợp:**

```bash
# 0. Backup CSDL trước (luôn làm, kể cả khi tưởng chỉ đổi code)
sqlcmd -S localhost -U sa -Q "BACKUP DATABASE VPDT_DMS TO DISK = '/var/backups/vpdt_$(date +%F).bak'"

cd /opt/vpdt
# 1. Lấy code mới (git pull hoặc copy đè)

cd server
# 2. Cài lại dependency (vô hại nếu không có gói mới)
npm install

# 3. Chạy lại schema.sql — an toàn chạy nhiều lần
sqlcmd -S localhost -U sa -i sql/schema.sql
# (dùng sqlcmd18 nếu Ubuntu 22.04+, xem mục 2)

# 4. Xem có biến .env mới cần thêm không
diff .env .env.example

# 5. Khởi động lại
pm2 restart vpdt
pm2 status      # phải thấy "online", KHÔNG phải liên tục "restart"/"errored"
```

Vì toàn bộ dữ liệu đã nằm trong SQL Server (không còn trong trình duyệt), việc
cập nhật giao diện/code **không làm mất dữ liệu người dùng đã nhập** — kể cả
khi có chạy lại `schema.sql` (script chỉ thêm mới, không xoá/ghi đè dữ liệu).

> ⚠️ **Lỗi thường gặp: web báo 502/503 sau khi cập nhật code, không truy cập
> được.** Nguyên nhân hầu hết là bỏ sót bước `npm install` — nếu code mới
> thêm gói mới trong `package.json` (`dependencies`) mà chưa cài, tiến trình
> Node sẽ báo lỗi `Cannot find module '...'` và **thoát ngay khi khởi động**,
> khiến PM2 cứ khởi động rồi crash liên tục (`pm2 status` sẽ thấy số lần
> restart tăng rất nhanh), Nginx không có gì để chuyển tiếp request tới nên
> trả về 502/503. Cách kiểm tra và khắc phục:
> ```bash
> pm2 logs vpdt --lines 50 --err   # tìm dòng "Cannot find module ..."
> cd /opt/vpdt && npm install
> pm2 restart vpdt
> ```
> Sau khi sửa, mở `GET /api/health` (mục 11) để xác nhận server đã lên và
> đúng phiên bản mới trước khi báo cho người dùng thử lại.
