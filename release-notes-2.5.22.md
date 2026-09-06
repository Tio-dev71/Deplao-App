## Sửa lỗi làm vỡ 3 tính năng ở bản 2.5.21

**Nguyên nhân**: preload của Zalo chạy trong sandbox (Electron từ 20 bật sandbox mặc định cho BrowserView). Bản 2.5.21 thêm `require('fs')` và `require('path')` vào đầu `preload.js`; trong sandbox hai lệnh này ném lỗi ngay dòng đầu và Electron hủy toàn bộ preload trong im lặng. Hậu quả:

- mất `contextBridge` → **Tin nhắn nhanh** không còn cầu nối
- mất `ipcRenderer.on('zalo-group-scan:start')` → **Quét nhóm Zalo** đứng ở "Đã đọc 0 trang • tìm thấy 0 ID"
- mất `ipcRenderer.on('zalo-user-scan:start')` → **Quét người dùng Zalo** đứng y như vậy

Bản 2.5.13 chỉ `require('electron')` nên chạy bình thường.

**Cách sửa**: bỏ hai require đó; font Quicksand do main process đọc từ đĩa rồi gửi kèm `get-settings`, preload không đọc file nữa. Thêm test chặn tái phạm: preload chỉ được require module an toàn trong sandbox và không được dùng `fs`.

**Tin nhắn nhanh**: trở lại trigger `/từ-khóa` và ẩn panel Tin nhắn nhanh gốc của Zalo Web (chỉ ẩn bằng CSS, không vá sâu vào Zalo).

## Thư viện video

- Kho media nằm **ngoài thư mục cài đặt**: `%AppData%\Nhà Yến Zalo\media\{videos,thumbnails,trash,video-library.json}`, đổi được sang ổ khác bằng **Đổi thư mục…** nên bản cập nhật không xóa video của anh.
- Chống trùng theo **nội dung tệp** (SHA-256): thêm lại cùng một video dù đổi tên thì báo "Đã có trong kho".
- Ảnh nền **PNG thật** và **thời lượng** đọc bằng chính Chromium, không cần ffmpeg. Tạo ảnh nền thất bại thì vẫn giữ video, chỉ báo "không tạo được ảnh nền".
- Xóa video là **chuyển vào thùng rác**, còn cứu lại được. Video biến mất thì báo "Video không còn tồn tại" thay vì treo.
- **Đưa vào xem trước** chỉ đặt video vào khung soạn; chỉ Enter của anh mới gửi.

## Popup công cụ không che Zalo

- Popup neo cạnh phải, **không lớp xám, không blur**: Zalo Web thu hẹp lại nhưng vẫn thấy và vẫn dùng được. Kéo thanh tiêu đề hoặc cạnh viền để đổi bề rộng; nháy đúp để về mặc định.
- Mỗi popup có **Hạ xuống** và **Đóng**; nút công cụ bật/tắt popup; mở công cụ khác thì popup đang mở tự hạ xuống.
- Hỏi xác nhận xóa video hiện **ngay trong popup**, không dùng hộp thoại hệ thống.

## Quét nhóm chạy nền

- Popup xuất nhóm có **Hạ xuống · vẫn chạy**; tiến độ hiện bằng thẻ `420/799` trên nút Nhóm Zalo, đổi nick không hủy phiên đang quét.
