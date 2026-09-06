# Nguyên tắc hoàn tất và phát hành Nhà Yến Zalo

Một phiên bản chỉ được báo là **đã hoàn tất** sau khi đủ toàn bộ các bước sau:

1. Nâng đúng phiên bản trong `package.json` và `package-lock.json`.
2. Chạy toàn bộ kiểm thử và không còn bài test lỗi.
3. Build bộ cài Windows thành công.
4. Kiểm tra ProductVersion/FileVersion và mở `app.asar` xác nhận chứa mã mới.
5. Phát hành lên kho cập nhật `thaophamce/nhayen-zalo-updates` với đủ:
   - `Nha-Yen-Zalo-Setup-<version>.exe`
   - `Nha-Yen-Zalo-Setup-<version>.exe.blockmap`
   - `latest.yml`
6. Kiểm tra release mới đã là **Latest** và ba tài sản tải xuống đều tồn tại.
7. Xác minh một bản cũ có thể nhìn thấy phiên bản mới qua nút **Kiểm tra cập nhật**.
8. Chỉ sau đó mới gửi bộ cài và báo hoàn tất cho anh.

Nếu chưa phát hành hoặc chưa xác minh auto-update, phải nói rõ là **bản build cục bộ**, không được gọi là bản hoàn tất.
