# Ghi chú cho Claude khi làm việc trên repo này

## Lưu ý bắt buộc khi báo cáo thay đổi liên quan tới deploy

Người dùng chạy `server/` trên máy chủ thật riêng, KHÔNG tự động đồng bộ code
qua git — mỗi lần cập nhật là thao tác thủ công. Khi báo cáo bất kỳ thay đổi
nào đã commit/push/merge, **luôn kiểm tra và nêu rõ** nếu thay đổi đó yêu cầu
làm thêm gì ngoài việc copy code + `pm2 restart`, cụ thể là:

- `server/sql/schema.sql` có đổi không (bảng/cột/index mới hoặc sửa lỗi
  trong script) — nếu có, phải nhắc chạy lại (an toàn, script tự bọc
  `IF OBJECT_ID(...) IS NULL`).
- `server/.env.example` có thêm biến môi trường mới không — nêu rõ biến nào
  **bắt buộc** để server khởi động được, biến nào chỉ cần khi dùng đúng tính
  năng liên quan.
- `server/package.json` có thêm/đổi `dependencies` không — nếu có, nhắc chạy
  `npm install` lại.
- Có cần thao tác 1 lần nào khác không (migrate dữ liệu thủ công, đổi cấu
  hình PM2/Nginx...).

Không giả định người dùng tự soát các file diff này — luôn liệt kê tường
minh trong phần tóm tắt, kể cả khi câu trả lời là "không cần làm gì thêm
ngoài copy code".

Quy trình cập nhật đầy đủ đã viết sẵn ở mục 12 `HUONG_DAN_DEPLOY_UBUNTU.md`
(thư mục gốc, bản DUY NHẤT — đã gộp bản trùng lặp từng có trong `server/`) —
trỏ người dùng tới đó thay vì lặp lại toàn bộ mỗi lần, chỉ nêu phần khác biệt
cụ thể của lần cập nhật đang báo cáo.

## Luôn tăng version khi merge vào main

Mỗi lần merge PR vào main (bất kể tính năng lớn hay fix nhỏ), **luôn tăng
`server/package.json` field `version`** trong CÙNG PR trước khi merge. Đây là
version DUY NHẤT client đọc (badge góc màn hình + `/api/health`, xem
`server.js` require `./package.json`), không có bản sao nào khác cần sửa.
Nếu lỡ quên ở 1-2 lần merge trước, bump bắt kịp luôn (cộng dồn số lần đã bỏ
lỡ) ở lần merge kế tiếp thay vì bỏ qua.

**Định dạng version (từ v2.0 trở đi, KHÔNG còn semver 3 phần):** chỉ 2 số
`MAJOR.MINOR` (VD `"2.0"`, `"2.1"`... không có số thứ 3 kiểu `.0` ở cuối).
MINOR chỉ chạy từ 0 đến 9 — mỗi lần merge tăng MINOR lên 1 (`2.0`→`2.1`→...→
`2.9`), và lần merge NGAY SAU khi đang ở `X.9` thì tăng MAJOR lên 1 và reset
MINOR về 0 (`2.9`→`3.0`→`3.1`...). Không phân biệt patch/minor theo mức độ
thay đổi nữa — mọi lần merge (dù fix nhỏ hay tính năng lớn) đều tăng đúng 1
bậc theo quy tắc này. Version trước v2.0 (`1.75.0`...`1.102.0`, kiểu semver 3
phần cũ) đã ngừng dùng — không lùi lại đổi các bản ghi lịch sử cũ.

## Ô tìm-kiếm-gõ-chọn (searchable picker): KHÔNG dùng `<input list>`+`<datalist>` native

Cơ chế `<datalist>` gốc của trình duyệt không đáng tin cậy trên nhiều
trình duyệt/thiết bị (đã xác nhận lỗi thực tế trên Chrome/Firefox/Edge
desktop lẫn Chrome-Samsung/Safari-iPhone dù dữ liệu/logic lọc phía sau
vẫn đúng — xem lịch sử ở block `sdd*` trong `public/index.html`, ngay
trước `renderPeopleMultiSelect()`). Toàn bộ 19 điểm dùng datalist trong
hệ thống đã được thay bằng widget JS tự dựng, không phụ thuộc thư viện
ngoài: `sddSetOptions(dropdownId, items)` để nạp danh sách, input dùng
`data-sdd-list="dropdownId"` (thay cho `list="..."`), dropdown là
`<div id="dropdownId" class="hidden sdd-dropdown" data-sdd-dropdown></div>`
(thay cho `<datalist>`). Xem chú thích 3 bước migrate ngay tại block
`sdd*`. **Mọi ô tìm-kiếm-gõ-chọn mới từ giờ trở đi phải dùng cơ chế này**
(hoặc `renderPeopleMultiSelect()`/dropdown tự dựng tương tự nếu cần
multi-select thật sự) — không quay lại `<datalist>` native.
