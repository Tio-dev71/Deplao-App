# Changelog

## 2.5.25 - 2026-09-02

### Don Pancake: boc het CRM, bo cuc lai giao dien

- **Bo phu thuoc CRM trong tab Don Pancake**: `refreshPancakeCurrent` chi con goi thang
  Pancake API (bat ma `Dxxxx` tu ten hoi thoai -> tim don -> tai chi tiet), khong con
  `resolveCrmConversation` / `crmRequest` by-conversation / sync-by-conversation. Tab
  **Don Pancake** mo duoc va tai duoc don ngay ca khi chua ket noi CRM; an badge **CRM ✓**
  khi o tab nay. CRM van giu nguyen o Bao gia, thiet ke, workspace, quick replies.
- **Nut "Tao don qua CRM" -> "Luu thay doi"**: nut go `PUT /shops/609730/orders/{code}`
  bang Pancake API key de luu thay doi len don dang mo. Neu chua tai don nao thi bao
  "Chua tai don Pancake nao de luu". Nut **Tao don** (POST) giu nguyen nhu 2.5.24.
- **Nut "Lam moi" canh nut "Dong"** o dau panel: chi hien khi o tab Don Pancake; bam de
  doc lai ten hoi thoai hien tai va bat lai ma don (huu ich khi doi sang nhom khac).
- **Ma don duoi trang thai "Da tai"**: phóng to `h4` (~26px), mau xanh app `#1767d9`, dam chu.
  Chi ap cho badge `linked`, khong anh huong cac trang thai khac.
- **Bo cuc**: thu hep khoi Khach hang / Thanh toan / Tim don (padding + gap), khoi **San pham**
  `flex:1 1 260px` + `min-height:260px` + `#pancake-items` `max-height:none`/`flex:1` de
  nhieu san pham van nhap duoc, khong bi chan 190px nhu cu.


## 2.5.24 - 2026-09-02

### Don Pancake goi thang Pancake API

- Don Pancake goi thang `pos.pages.fm/api/v1` bang key chinh hang, khong qua CRM nen nhanh hon. Key chi nam o main process, renderer goi qua kenh `pancake:request` da kiem duyet endpoint.
- O do (hop trang thai don) hien ma don bat duoc (`Dxxxx`) khi chua lien ket de kiem tra Pancake co bat dung don khong; khi da lien ket van hien "Da lien ket" nhu cu.
- Them nut **Tao don** ben canh **Tao don qua CRM**: tao don thang tren Pancake bang API key, moi may deu dung duoc, khong can lien ket nhom Zalo voi don trong CRM.
- Sua nhan nut "Thiet lap lai" ve "Tao don qua CRM" cho nhat quan; nut "Tao don" tu quan ly nhan rieng.


## 2.5.23 - 2026-09-01

### Tin nhan nhanh: trigger chuyen sang dau gach cheo nguoc

- Theo chot cua anh chu: go `\tu-khoa` trong o chat Zalo de chen mau (vd `\xanhla`),
  khong con dung dau `/`.
- Tu khoa da luu khong bi anh huong: `normalizeQuickReplyKeyword` luon boc dau `/` va `\`
  o dau tu khoa truoc khi luu, nen doi trigger khong lam hong mau cu.
- Van an panel Tin nhan nhanh goc cua Zalo Web chi bang CSS (`display:none !important`),
  khong va sau vao Zalo.

## 2.5.22 - 2026-09-01

### Sua loi lam vo 3 tinh nang o ban 2.5.21

- **Nguyen nhan**: preload cua Zalo chay trong sandbox (Electron >= 20 bat sandbox mac dinh
  cho BrowserView). Ban 2.5.21 them `require('fs')` va `require('path')` vao dau `preload.js`;
  trong sandbox hai lenh nay nem loi ngay dong dau, Electron huy toan bo preload trong im lang.
  Hau qua la mat luon `contextBridge` (**Tin nhan nhanh** khong con cau noi) va mat cac
  `ipcRenderer.on('zalo-group-scan:start')` / `('zalo-user-scan:start')` (**Quet nhom Zalo**
  va **Quet nguoi dung Zalo** dung o "Da doc 0 trang - tim thay 0 ID"). Ban 2.5.13 chi
  `require('electron')` nen chay binh thuong.
- **Cach sua**: bo hai require do; font Quicksand duoc main process doc tu dia roi gui kem
  theo `get-settings`, preload khong doc file nua. Them test chan tai pham: `preload.js` chi
  duoc require module an toan trong sandbox va khong duoc dung `fs`.
- **Tin nhan nhanh**: tro lai trigger `/tukhoa` va an panel Tin nhan nhanh goc cua Zalo Web
  (chi an bang CSS, khong va sau vao Zalo).

### Thu vien video (thay hop thoai chon tep cua Windows)

- Kho media nam **ngoai thu muc cai dat** va khong dong goi vao app:
  `%AppData%\Nha Yen Zalo\media\{videos,thumbnails,trash,video-library.json}`, doi duoc sang
  o khac bang **Doi thu muc...** nen ban cap nhat khong xoa video cua nguoi dung.
- Chong trung theo **noi dung tep** (SHA-256), them lai cung mot video du doi ten thi bao
  "Da co trong kho" chu khong nhan doi.
- Anh nen **PNG that** va **thoi luong** doc bang chinh Chromium, khong can ffmpeg; tao anh nen
  that bai thi van giu video va chi bao "khong tao duoc anh nen".
- Xoa video la **chuyen vao thung rac**, con cuu lai duoc. Ban ghi tro toi tep da mat bi bo
  khoi danh sach thay vi treo. Video bien mat thi bao "Video khong con ton tai."
- **Dua vao xem truoc** chi dat video vao khung soan; chi Enter cua nguoi dung moi gui.

### Popup cong cu khong che Zalo

- Popup neo canh phai, **khong lop xam, khong blur**: Zalo Web thu hep lai nhung van thay va
  van dung duoc. Keo thanh tieu de hoac cach vien de doi be rong; nhay dup de ve mac dinh.
- Moi popup co **Ha xuong** va **Dong**; nut cong cu bat/tat popup; mo cong cu khac thi popup
  dang mo tu ha xuong.
- Hoi xac nhan xoa video hien **ngay trong popup**, khong dung hop thoai he thong.

### Quet nhom chay nen

- Popup xuat nhom co **Ha xuong - van chay**; tien do hien bang the `420/799` tren nut
  Nhom Zalo, doi nick khong huy phien dang quet.

## 2.5.9 - 2026-08-30

- Hiển thị số phiên bản (**v2.5.9**) ngay cạnh tên **Nhà Yến Zalo** trên thanh tiêu đề, lấy tự động từ `package.json`; bấm vào để kiểm tra cập nhật.
- Thêm nút **Gửi video** trên thanh tiêu đề; video được đưa vào hội thoại Zalo ở trạng thái chờ và chỉ gửi khi người dùng nhấn Enter.
- Nhập mẫu trả lời nhanh từ Nhà Yến CRM theo workspace, giữ mẫu hiện có, xử lý từ khóa trùng và tải ảnh đính kèm về máy.
- Hoàn thiện giao diện Nhà Yến Zalo, công cụ quản lý người dùng/nhóm và luồng cập nhật tự động.
- Bổ sung kiểm thử hồi quy cho quick replies, video chờ gửi và các công cụ quản trị Zalo.
